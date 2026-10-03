import type { App } from 'obsidian';
import * as os from 'node:os';
import { DEFAULT_SYNC_CONFIG, type SyncConfig } from './core/types';

export interface PluginSettings {
  remoteUrl: string;
  branch: string;
  authMode: 'credential-helper' | 'pat';
  gitPath: string;
  autoSyncEnabled: boolean;
  autoSyncIntervalSec: number;
  deviceName: string;
  commitMessageTemplate: string;
  autoResolveConfigFiles: boolean;
  keepConflictCopies: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  remoteUrl: '',
  branch: DEFAULT_SYNC_CONFIG.branch,
  authMode: 'credential-helper',
  gitPath: '',
  autoSyncEnabled: true,
  autoSyncIntervalSec: 300,
  deviceName: os.hostname() || 'unknown-device',
  commitMessageTemplate: DEFAULT_SYNC_CONFIG.commitMessageTemplate,
  autoResolveConfigFiles: true,
  keepConflictCopies: true,
};

export const TOKEN_SECRET_KEY = 'github-vault-sync-token';

interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/**
 * Obsidian 1.11.4+ 提供了 app.secretStorage，用它存 Token 可以避免
 * 明文写进 data.json（data.json 就在 Vault 里，会被云同步带走）。
 *
 * 注意方法名是 getSecret / setSecret —— 不是 get / set。
 * id 必须是「小写字母数字加连字符」，否则 setSecret 会抛错。
 * 类型定义里可能没有这个成员，因此做特性探测而不是直接引用。
 */
export function getSecretStorage(app: App): SecretStorageLike | null {
  const candidate = (app as unknown as { secretStorage?: Partial<SecretStorageLike> }).secretStorage;
  if (
    candidate &&
    typeof candidate.getSecret === 'function' &&
    typeof candidate.setSecret === 'function'
  ) {
    return candidate as SecretStorageLike;
  }
  return null;
}

export function readToken(app: App, legacy: Partial<PluginSettings> & { token?: string }): string {
  const storage = getSecretStorage(app);
  if (storage) {
    try {
      const stored = storage.getSecret(TOKEN_SECRET_KEY);
      if (typeof stored === 'string' && stored.length > 0) {
        return stored;
      }
    } catch {
      // 落到下面的 data.json 回退路径
    }
  }
  return typeof legacy.token === 'string' ? legacy.token : '';
}

export function writeToken(app: App, token: string): boolean {
  const storage = getSecretStorage(app);
  if (!storage) {
    return false;
  }
  try {
    storage.setSecret(TOKEN_SECRET_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/** 把插件设置投影成核心层需要的 SyncConfig */
export function toSyncConfig(settings: PluginSettings, configDir: string): SyncConfig {
  return {
    ...DEFAULT_SYNC_CONFIG,
    remoteUrl: settings.remoteUrl.trim(),
    branch: settings.branch.trim() || DEFAULT_SYNC_CONFIG.branch,
    deviceName: settings.deviceName.trim() || 'unknown-device',
    commitMessageTemplate: settings.commitMessageTemplate || DEFAULT_SYNC_CONFIG.commitMessageTemplate,
    configDir,
    autoResolveConfigFiles: settings.autoResolveConfigFiles,
    keepConflictCopies: settings.keepConflictCopies,
  };
}
