/**
 * 核心层类型定义。
 *
 * 重要：本目录（src/core）下的所有模块**不得 import 'obsidian'**。
 * 这是刻意的架构接缝 —— git 逻辑与 Obsidian API 解耦后，
 * 既能在插件里跑，也能在纯 Node 环境下做端到端验收测试。
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
}

export type AuthConfig =
  | { mode: 'credential-helper' }
  | { mode: 'pat'; username: string; token: string }
  | { mode: 'none' };

export interface SyncConfig {
  /** 远端地址，必须是不含凭据的干净 URL */
  remoteUrl: string;
  branch: string;
  deviceName: string;
  commitMessageTemplate: string;
  /** Obsidian 配置目录名（app.vault.configDir），不硬编码 .obsidian */
  configDir: string;
  /** 配置类文件冲突时是否自动保留本地版本（merge=ours 分流） */
  autoResolveConfigFiles: boolean;
  /** 行级合并失败时是否额外保存对方版本为副本 */
  keepConflictCopies: boolean;
  maxPushRetries: number;
  fetchTimeoutMs: number;
  pushTimeoutMs: number;
  defaultTimeoutMs: number;
}

export const DEFAULT_SYNC_CONFIG: Omit<SyncConfig, 'remoteUrl' | 'configDir'> = {
  branch: 'main',
  deviceName: 'unknown-device',
  commitMessageTemplate: 'vault sync: {{date}} @{{device}}',
  autoResolveConfigFiles: true,
  keepConflictCopies: true,
  maxPushRetries: 3,
  fetchTimeoutMs: 120000,
  pushTimeoutMs: 120000,
  defaultTimeoutMs: 60000,
};

export type SyncStatus =
  | 'ok'
  | 'up-to-date'
  | 'offline'
  | 'conflict'
  | 'blocked'
  | 'failed'
  | 'skipped';

export interface SyncOutcome {
  status: SyncStatus;
  message: string;
  ahead: number;
  behind: number;
  conflicts: string[];
  committed: boolean;
  pushed: boolean;
}

export type SyncTrigger = 'manual' | 'timer' | 'startup' | 'test';

export interface EngineHooks {
  log?(level: 'info' | 'warn' | 'error', message: string): void;
  /** 发生冲突时回调，供 UI 弹出通知并提供"打开冲突文件"入口 */
  onConflict?(files: string[]): void;
}

export function makeOutcome(partial: Partial<SyncOutcome> & { status: SyncStatus; message: string }): SyncOutcome {
  return {
    ahead: 0,
    behind: 0,
    conflicts: [],
    committed: false,
    pushed: false,
    ...partial,
  };
}
