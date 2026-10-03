import { FileSystemAdapter, Modal, Notice, Plugin, type App } from 'obsidian';
import { ensureRepo } from './core/bootstrap';
import { SyncEngine } from './core/engine';
import { locateGit } from './core/git-locate';
import { GitRunner } from './core/git-runner';
import { Redactor } from './core/redact';
import type { AuthConfig, SyncOutcome, SyncTrigger } from './core/types';
import { GvsSettingTab } from './settings-tab';
import {
  DEFAULT_SETTINGS,
  readToken,
  toSyncConfig,
  writeToken,
  type PluginSettings,
} from './settings';
import { VaultWatcher } from './watcher';

const MAX_LOG_LINES = 300;
const FOLLOW_UP_DELAY_MS = 3000;

class LogModal extends Modal {
  constructor(app: App, private readonly lines: string[]) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: 'GitHub Vault Sync 日志' });
    // 样式一律走 CSS 类，不写内联样式，否则用户无法用主题或 CSS 片段覆盖
    const pre = this.contentEl.createEl('pre', { cls: 'gvs-log-content' });
    pre.setText(this.lines.length > 0 ? this.lines.join('\n') : '（暂无日志）');
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class GvsPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };

  private runner: GitRunner | null = null;
  private engine: SyncEngine | null = null;
  private watcher: VaultWatcher | null = null;
  private statusBarEl: HTMLElement | null = null;
  private timerId: number | null = null;
  private logs: string[] = [];
  private token = '';
  private readonly redactor = new Redactor();
  private gitPath: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.token = readToken(this.app, this.settings as never);
    if (this.token) {
      this.redactor.add(this.token);
    }

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('gvs-status-bar');
    this.statusBarEl.addEventListener('click', () => {
      void this.runSync('manual');
    });
    this.setStatus('✓ 待同步', '', '点击立即同步');

    this.addSettingTab(new GvsSettingTab(this.app, this));

    this.addCommand({
      id: 'sync-now',
      name: '立即同步',
      callback: () => {
        void this.runSync('manual');
      },
    });
    this.addCommand({
      id: 'show-log',
      name: '查看同步日志',
      callback: () => this.showLog(),
    });
    this.addCommand({
      id: 'init-repo',
      name: '初始化当前仓库',
      callback: () => {
        void this.initializeRepo();
      },
    });

    this.watcher = new VaultWatcher(this, { debounceMs: 3000 }, () => {
      // 当前默认是"定时 + 手动"触发，不按保存事件自动同步。
      // 保留回调是为了后续开放"保存后同步"开关。
    });

    this.app.workspace.onLayoutReady(() => {
      this.watcher?.start();
      this.restartTimer();
      if (this.settings.autoSyncEnabled && this.settings.remoteUrl) {
        window.setTimeout(() => {
          void this.runSync('startup');
        }, 5000);
      }
    });

    this.log('info', '插件已加载');
  }

  onunload(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    this.watcher?.dispose();
    this.watcher = null;
    if (this.engine?.isRunning) {
      this.log('warn', '插件卸载时有同步正在进行；已放弃等待（退出时不发起新同步）');
    }
    this.redactor.clear();
  }

  // ─────────────────────────── 设置 ───────────────────────────

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as (Partial<PluginSettings> & { token?: string }) | null;
    const { token: legacyToken, ...rest } = raw ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...rest };

    // 兼容早期把 Token 明文写在 data.json 里的版本，迁移到 secretStorage
    if (typeof legacyToken === 'string' && legacyToken.length > 0) {
      if (writeToken(this.app, legacyToken)) {
        await this.saveSettings();
        this.log('info', '已把 data.json 中的明文令牌迁移到 secretStorage');
      } else {
        // 没有 secretStorage 的旧版本 Obsidian：必须把令牌留在 data.json，
        // 否则它会在这里被静默丢弃，用户会看到"凭据突然失效"。
        (this.settings as unknown as { token?: string }).token = legacyToken;
        this.log('warn', '当前 Obsidian 无 secretStorage，令牌仍以明文保存在 data.json 中');
      }
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings });
  }

  async applySettings(): Promise<void> {
    await this.saveSettings();
    this.rebuildEngine();
    this.restartTimer();
  }

  getToken(): string {
    return this.token;
  }

  async setToken(token: string): Promise<void> {
    if (this.token) {
      this.redactor.forget(this.token);
    }
    this.token = token;
    if (token) {
      this.redactor.add(token);
    }
    if (!writeToken(this.app, token)) {
      // 没有 secretStorage 的旧版本 Obsidian：退回 data.json（设置页已给出明文风险提示）
      (this.settings as unknown as { token?: string }).token = token;
    }
    await this.saveSettings();
    this.rebuildEngine();
  }

  // ─────────────────────────── 引擎装配 ───────────────────────────

  private getVaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    const candidate = adapter as unknown as { getBasePath?: () => string };
    return typeof candidate.getBasePath === 'function' ? candidate.getBasePath() : null;
  }

  private buildAuth(): AuthConfig {
    if (this.settings.authMode === 'pat' && this.token.length > 0) {
      return { mode: 'pat', username: 'x-access-token', token: this.token };
    }
    return { mode: 'credential-helper' };
  }

  private rebuildEngine(): void {
    const basePath = this.getVaultBasePath();
    if (!basePath || !this.gitPath) {
      this.engine = null;
      return;
    }

    const auth = this.buildAuth();
    if (!this.runner) {
      this.runner = new GitRunner(this.gitPath, basePath, { redactor: this.redactor, auth });
    } else {
      this.runner.setAuth(auth);
    }

    const config = toSyncConfig(this.settings, this.app.vault.configDir);
    if (this.engine) {
      this.engine.updateConfig(config);
    } else {
      this.engine = new SyncEngine(this.runner, config, {
        log: (level, message) => this.log(level, message),
        onConflict: (files) => {
          this.log('warn', `冲突文件：${files.join(', ')}`);
        },
      });
    }
  }

  private async ensureEngine(): Promise<SyncEngine | null> {
    if (!this.gitPath) {
      const found = await locateGit(this.settings.gitPath);
      if (!found) {
        this.setStatus('✗ 未找到 git', 'is-error', '请在插件设置中填写 git 可执行文件路径');
        return null;
      }
      this.gitPath = found.path;
      this.log('info', `使用 git：${found.version}（${found.path}，来源 ${found.source}）`);
    }
    this.rebuildEngine();
    return this.engine;
  }

  private restartTimer(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    if (!this.settings.autoSyncEnabled) {
      return;
    }
    const seconds = Math.max(30, this.settings.autoSyncIntervalSec);
    this.timerId = window.setInterval(() => {
      void this.runSync('timer');
    }, seconds * 1000);
  }

  // ─────────────────────────── 同步 ───────────────────────────

  async runSync(trigger: SyncTrigger): Promise<SyncOutcome | null> {
    if (this.settings.remoteUrl.trim().length === 0) {
      new Notice('请先在插件设置中填写远端仓库地址');
      return null;
    }

    const engine = await this.ensureEngine();
    if (!engine) {
      new Notice('未找到可用的 git，请在插件设置中指定路径');
      return null;
    }
    if (engine.isRunning) {
      new Notice('已有一轮同步正在进行中');
      return null;
    }

    this.watcher?.suspend();
    this.setStatus('⇅ 同步中…', 'is-busy', '正在同步');

    try {
      const outcome = await engine.syncOnce(trigger);
      this.applyOutcome(outcome, trigger);
      return outcome;
    } finally {
      this.watcher?.resume();
      const pending = this.watcher?.consumePendingCount() ?? 0;
      if (pending > 0) {
        this.log('info', `同步期间检测到 ${pending} 次文件改动，将在下一轮处理`);
        window.setTimeout(() => {
          void this.runSync('timer');
        }, FOLLOW_UP_DELAY_MS);
      }
    }
  }

  private applyOutcome(outcome: SyncOutcome, trigger: SyncTrigger): void {
    this.log(
      outcome.status === 'failed' ? 'error' : 'info',
      `[${trigger}] ${outcome.status} — ${outcome.message}`
    );

    switch (outcome.status) {
      case 'ok':
      case 'up-to-date':
        this.setStatus(outcome.ahead > 0 ? `↑${outcome.ahead}` : '✓ 已同步', '', outcome.message);
        if (trigger === 'manual') {
          new Notice(`同步完成：${outcome.message}`);
        }
        break;
      case 'offline':
        this.setStatus('☁ 离线', 'is-offline', outcome.message);
        if (trigger === 'manual') {
          new Notice(`离线：${outcome.message}`);
        }
        break;
      case 'conflict':
        this.setStatus(`⚠ 冲突 ${outcome.conflicts.length}`, 'is-conflict', outcome.message);
        new Notice(`同步冲突：${outcome.message}`);
        break;
      case 'blocked':
        this.setStatus('⚠ 待解决', 'is-conflict', outcome.message);
        new Notice(outcome.message);
        break;
      case 'skipped':
        break;
      case 'failed':
        this.setStatus('✗ 失败', 'is-error', outcome.message);
        new Notice(`同步失败：${outcome.message}`);
        break;
    }
  }

  private async initializeRepo(): Promise<void> {
    if (this.settings.remoteUrl.trim().length === 0) {
      new Notice('请先填写远端仓库地址');
      return;
    }
    const engine = await this.ensureEngine();
    if (!engine || !this.runner) {
      new Notice('未找到可用的 git');
      return;
    }

    const report = await ensureRepo(this.runner, {
      remoteUrl: this.settings.remoteUrl.trim(),
      branch: this.settings.branch.trim() || 'main',
      configDir: this.app.vault.configDir,
    });
    this.log('info', `初始化报告：${JSON.stringify(report)}`);

    new Notice(
      [
        '仓库初始化完成',
        `新建 git 仓库：${report.initialized ? '是' : '否'}`,
        `.gitignore 更新：${report.gitignoreWritten ? '是' : '否'}`,
        `.gitattributes 更新：${report.gitattributesWritten ? '是' : '否'}`,
        report.warnings.length > 0 ? `注意：${report.warnings.join('；')}` : '',
      ]
        .filter((line) => line.length > 0)
        .join('\n')
    );

    await this.runSync('manual');
  }

  // ─────────────────────────── 杂项 ───────────────────────────

  showLog(): void {
    new LogModal(this.app, this.logs).open();
  }

  private setStatus(text: string, cls: string, tooltip: string): void {
    const el = this.statusBarEl;
    if (!el) {
      return;
    }
    el.setText(text);
    el.className = 'gvs-status-bar';
    if (cls.length > 0) {
      el.addClass(cls);
    }
    el.title = tooltip;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    const line = `${stamp} [${level}] ${this.redactor.redact(message)}`;
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    }
    // 按 Obsidian 插件规范：默认配置下控制台只应出现错误，
    // 普通信息留在插件内的日志缓冲里，用「查看同步日志」命令查看。
    if (level === 'error') {
      console.error('[github-vault-sync]', line);
    } else if (level === 'warn') {
      console.warn('[github-vault-sync]', line);
    }
  }
}
