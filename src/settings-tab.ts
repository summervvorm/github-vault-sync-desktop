import { Notice, PluginSettingTab, Setting, type App } from 'obsidian';
import { locateGit } from './core/git-locate';
import { getSecretStorage } from './settings';
import type GvsPlugin from './main';

export class GvsSettingTab extends PluginSettingTab {
  private readonly gvsPlugin: GvsPlugin;

  constructor(app: App, plugin: GvsPlugin) {
    super(app, plugin);
    this.gvsPlugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const storageAvailable = getSecretStorage(this.app) !== null;

    // ── 仓库 ──
    new Setting(containerEl).setName('仓库').setHeading();

    new Setting(containerEl)
      .setName('远端仓库地址')
      .setDesc('形如 https://github.com/用户名/仓库名.git —— 不要在这里内嵌 Token')
      .addText((text) =>
        text
          .setPlaceholder('https://github.com/owner/repo.git')
          .setValue(this.gvsPlugin.settings.remoteUrl)
          .onChange(async (value) => {
            this.gvsPlugin.settings.remoteUrl = value.trim();
            await this.gvsPlugin.applySettings();
          })
      );

    new Setting(containerEl)
      .setName('分支')
      .setDesc('同步使用的分支，默认 main')
      .addText((text) =>
        text
          .setPlaceholder('main')
          .setValue(this.gvsPlugin.settings.branch)
          .onChange(async (value) => {
            this.gvsPlugin.settings.branch = value.trim() || 'main';
            await this.gvsPlugin.applySettings();
          })
      );

    new Setting(containerEl)
      .setName('设备名')
      .setDesc('写进提交信息和冲突副本文件名，用于区分是哪台设备做的改动')
      .addText((text) =>
        text.setValue(this.gvsPlugin.settings.deviceName).onChange(async (value) => {
          this.gvsPlugin.settings.deviceName = value.trim() || 'unknown-device';
          await this.gvsPlugin.applySettings();
        })
      );

    // ── 认证 ──
    new Setting(containerEl).setName('认证').setHeading();

    new Setting(containerEl)
      .setName('认证方式')
      .setDesc('优先用系统凭据助手：Token 由操作系统加密保管，完全不进入 Vault')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('credential-helper', '系统凭据助手（推荐）')
          .addOption('pat', '个人访问令牌 PAT')
          .setValue(this.gvsPlugin.settings.authMode)
          .onChange(async (value) => {
            this.gvsPlugin.settings.authMode = value as 'credential-helper' | 'pat';
            await this.gvsPlugin.applySettings();
            this.display();
          })
      );

    if (this.gvsPlugin.settings.authMode === 'pat') {
      new Setting(containerEl)
        .setName('个人访问令牌')
        .setDesc(
          storageAvailable
            ? '使用 Obsidian 的 secretStorage 保存，不会写进 data.json'
            : '当前 Obsidian 版本没有 secretStorage，令牌将以明文保存在插件 data.json 中'
        )
        .addText((text) => {
          text.inputEl.type = 'password';
          text
            .setPlaceholder('github_pat_... 或 ghp_...')
            .setValue(this.gvsPlugin.getToken())
            .onChange(async (value) => {
              await this.gvsPlugin.setToken(value.trim());
            });
        });

      if (!storageAvailable) {
        containerEl.createEl('div', {
          cls: 'gvs-settings-warning',
          text: '⚠️ 明文存储风险：data.json 位于 Vault 内，会被云同步带走。请确认它已被 .gitignore 屏蔽。',
        });
      }
    }

    // ── 环境 ──
    new Setting(containerEl).setName('环境').setHeading();

    new Setting(containerEl)
      .setName('git 可执行文件路径')
      .setDesc('留空则自动探测（PATH → 各平台常见安装位置）')
      .addText((text) =>
        text
          .setPlaceholder('自动探测')
          .setValue(this.gvsPlugin.settings.gitPath)
          .onChange(async (value) => {
            this.gvsPlugin.settings.gitPath = value.trim();
            await this.gvsPlugin.applySettings();
          })
      )
      .addButton((button) =>
        button.setButtonText('探测').onClick(async () => {
          const found = await locateGit(this.gvsPlugin.settings.gitPath);
          if (found) {
            new Notice(`找到 git：${found.version}\n${found.path}`);
          } else {
            new Notice('未找到可用的 git，请手动填写完整路径');
          }
        })
      );

    // ── 同步行为 ──
    new Setting(containerEl).setName('同步行为').setHeading();

    new Setting(containerEl)
      .setName('定时自动同步')
      .addToggle((toggle) =>
        toggle.setValue(this.gvsPlugin.settings.autoSyncEnabled).onChange(async (value) => {
          this.gvsPlugin.settings.autoSyncEnabled = value;
          await this.gvsPlugin.applySettings();
        })
      );

    new Setting(containerEl)
      .setName('同步间隔（秒）')
      .setDesc('建议 300 秒；间隔过短会显著提高冲突概率')
      .addText((text) =>
        text.setValue(String(this.gvsPlugin.settings.autoSyncIntervalSec)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.gvsPlugin.settings.autoSyncIntervalSec =
            Number.isFinite(parsed) && parsed >= 30 ? parsed : 300;
          await this.gvsPlugin.applySettings();
        })
      );

    new Setting(containerEl)
      .setName('提交信息模板')
      .setDesc('可用变量：{{date}} {{device}} {{branch}} {{trigger}}')
      .addText((text) =>
        text.setValue(this.gvsPlugin.settings.commitMessageTemplate).onChange(async (value) => {
          this.gvsPlugin.settings.commitMessageTemplate = value;
          await this.gvsPlugin.applySettings();
        })
      );

    new Setting(containerEl)
      .setName('配置类文件冲突时保留本地')
      .setDesc('对配置目录下的 .json 用 merge=ours 策略，避免无意义冲突')
      .addToggle((toggle) =>
        toggle.setValue(this.gvsPlugin.settings.autoResolveConfigFiles).onChange(async (value) => {
          this.gvsPlugin.settings.autoResolveConfigFiles = value;
          await this.gvsPlugin.applySettings();
        })
      );

    new Setting(containerEl)
      .setName('行级合并失败时保存对方版本副本')
      .setDesc('另存为 xxx.conflict-设备名-时间戳.md。强烈建议开启：冲突标记被误删时这是唯一的兜底')
      .addToggle((toggle) =>
        toggle.setValue(this.gvsPlugin.settings.keepConflictCopies).onChange(async (value) => {
          this.gvsPlugin.settings.keepConflictCopies = value;
          await this.gvsPlugin.applySettings();
        })
      );

    // ── 操作 ──
    new Setting(containerEl).setName('操作').setHeading();

    new Setting(containerEl)
      .setName('立即同步')
      .setDesc('提交本地改动 → 拉取远端 → 推送')
      .addButton((button) =>
        button.setButtonText('同步').onClick(async () => {
          await this.gvsPlugin.runSync('manual');
        })
      )
      .addButton((button) =>
        button.setButtonText('查看日志').onClick(() => {
          this.gvsPlugin.showLog();
        })
      );
  }
}
