import { Plugin, type EventRef, type TAbstractFile } from 'obsidian';

/**
 * Vault 文件事件监听。
 *
 * 两个必须做对的地方：
 *  ① 事件注册要放在 onLayoutReady 之后 —— vault.on('create') 在 Vault 加载时
 *     会对**既有文件**也触发，在 onload 里注册会瞬间收到成百上千个事件。
 *  ② 同步期间必须挂起 —— git 检出文件会写工作区，不收窄就形成
 *     "同步 → 文件事件 → 同步" 的自触发死循环。
 */

export interface WatcherOptions {
  debounceMs: number;
  /** 同步期间累积的事件数，用于判断"同步窗口内是否又有新改动" */
  onChangeWhileSuspended?: () => void;
}

export class VaultWatcher {
  private refs: EventRef[] = [];
  private suspended = false;
  private pendingDuringSuspend = 0;
  private timer: number | null = null;
  private started = false;

  constructor(
    private readonly plugin: Plugin,
    private readonly options: WatcherOptions,
    private readonly onIdleChange: () => void
  ) {}

  get isSuspended(): boolean {
    return this.suspended;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    const handler = (file: TAbstractFile) => this.handle(file);
    const renameHandler = (file: TAbstractFile, oldPath: string) => this.handle(file, oldPath);

    // vault.on() 返回 EventRef；把它交给 plugin.registerEvent() 让 Obsidian
    // 在插件卸载时自动清理，同时自己留一份用于 dispose() 时提前解绑。
    const created = this.plugin.app.vault.on('create', handler);
    const modified = this.plugin.app.vault.on('modify', handler);
    const deleted = this.plugin.app.vault.on('delete', handler);
    const renamed = this.plugin.app.vault.on('rename', renameHandler);

    for (const ref of [created, modified, deleted, renamed]) {
      this.refs.push(ref);
      this.plugin.registerEvent(ref);
    }
  }

  private handle(file: TAbstractFile, oldPath?: string): void {
    const target = oldPath ?? file.path;
    if (this.shouldIgnore(target)) {
      return;
    }

    if (this.suspended) {
      this.pendingDuringSuspend += 1;
      this.options.onChangeWhileSuspended?.();
      return;
    }

    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.onIdleChange();
    }, this.options.debounceMs);
  }

  private shouldIgnore(vaultPath: string): boolean {
    const normalized = vaultPath.replace(/\\/g, '/');
    if (normalized.startsWith('.git/')) {
      return true;
    }
    if (normalized.startsWith('.trash/')) {
      return true;
    }
    const configDir = this.plugin.app.vault.configDir.replace(/\\/g, '/');
    if (normalized === `${configDir}/workspace.json` || normalized === `${configDir}/workspace-mobile.json`) {
      return true;
    }
    return false;
  }

  suspend(): void {
    this.suspended = true;
    this.pendingDuringSuspend = 0;
  }

  resume(): void {
    this.suspended = false;
  }

  /** 读取并清零"同步期间发生的改动数" */
  consumePendingCount(): number {
    const count = this.pendingDuringSuspend;
    this.pendingDuringSuspend = 0;
    return count;
  }

  dispose(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    for (const ref of this.refs) {
      this.plugin.app.vault.offref(ref);
    }
    this.refs = [];
    this.started = false;
  }
}
