import type { GitRunner } from './git-runner';
import { ensureRepo, isMergeInProgress, remoteBranchExists } from './bootstrap';
import { listUnmerged, resolveConflicts, timestamp } from './conflict';
import {
  makeOutcome,
  type EngineHooks,
  type SyncConfig,
  type SyncOutcome,
  type SyncTrigger,
} from './types';

/**
 * 同步引擎 —— 核心状态机。
 *
 * 顺序约束（设计文档 3.3.2）：
 *   ① 先检查"合并是否未完成"，再开始任何操作
 *   ② 先 commit 本地，再 fetch/merge
 *   ③ 先 fetch/merge，再 push
 * 并且全流程永不使用 --force。
 */

function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? '';
}

export function renderCommitMessage(
  template: string,
  vars: { date: string; device: string; branch: string; trigger: string }
): string {
  return template
    .replace(/\{\{\s*date\s*\}\}/g, vars.date)
    .replace(/\{\{\s*device\s*\}\}/g, vars.device)
    .replace(/\{\{\s*branch\s*\}\}/g, vars.branch)
    .replace(/\{\{\s*trigger\s*\}\}/g, vars.trigger);
}

function looksRejected(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes('non-fast-forward') ||
    text.includes('fetch first') ||
    text.includes('failed to push some refs') ||
    text.includes('behind its remote counterpart') ||
    text.includes('updates were rejected')
  );
}

function looksMissingRemoteRef(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return text.includes("couldn't find remote ref") || text.includes('could not find remote ref');
}

export class SyncEngine {
  private running = false;

  constructor(
    private readonly runner: GitRunner,
    private config: SyncConfig,
    private readonly hooks: EngineHooks = {}
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  updateConfig(config: SyncConfig): void {
    this.config = config;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.hooks.log?.(level, message);
  }

  /** 带互斥锁的单次同步入口 */
  async syncOnce(trigger: SyncTrigger): Promise<SyncOutcome> {
    if (this.running) {
      return makeOutcome({ status: 'skipped', message: '已有一轮同步正在进行中' });
    }
    this.running = true;
    try {
      return await this.runSync(trigger);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('error', `同步异常：${message}`);
      return makeOutcome({ status: 'failed', message });
    } finally {
      this.running = false;
    }
  }

  private async runSync(trigger: SyncTrigger): Promise<SyncOutcome> {
    const { runner, config } = this;

    if (config.remoteUrl.trim().length === 0) {
      return makeOutcome({ status: 'failed', message: '尚未配置远端仓库地址，无法同步' });
    }

    // ── ① 合并守卫：上一次的合并还没结束，绝不能继续 commit/push ──
    if (await isMergeInProgress(runner)) {
      const pending = await listUnmerged(runner);
      return makeOutcome({
        status: 'blocked',
        message: `上次合并尚未解决，请先处理 ${pending.length} 个冲突文件`,
        conflicts: pending,
      });
    }

    // ── ② 仓库守卫（幂等）──
    const boot = await ensureRepo(runner, {
      remoteUrl: config.remoteUrl,
      branch: config.branch,
      configDir: config.configDir,
    });
    if (!boot.remoteConfigured) {
      return makeOutcome({
        status: 'failed',
        message: `远端未配置成功：${boot.warnings.join('；') || '未知原因'}`,
      });
    }
    for (const warning of boot.warnings) {
      this.log('warn', warning);
    }

    // ── ③ 本地改动先落盘 ──
    const status = await runner.run(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { timeoutMs: config.defaultTimeoutMs }
    );
    if (status.failed) {
      return makeOutcome({ status: 'failed', message: `读取工作区状态失败：${firstLine(status.stderr)}` });
    }

    let committed = false;
    if (status.stdout.length > 0) {
      const identity = await this.ensureIdentity();
      if (!identity) {
        return makeOutcome({
          status: 'failed',
          message: 'git 缺少 user.name / user.email，无法提交。请在设置中填写提交身份。',
        });
      }

      const add = await runner.run(['add', '-A']);
      if (add.failed) {
        return makeOutcome({ status: 'failed', message: `暂存失败：${firstLine(add.stderr)}` });
      }

      const message = renderCommitMessage(config.commitMessageTemplate, {
        date: new Date().toISOString().replace('T', ' ').slice(0, 19),
        device: config.deviceName,
        branch: config.branch,
        trigger,
      });
      const commit = await runner.run(['commit', '-m', message, '--no-verify']);
      if (commit.failed) {
        return makeOutcome({ status: 'failed', message: `提交失败：${firstLine(commit.stderr)}` });
      }
      committed = true;
    }

    // ── ④ fetch → merge → push，push 被拒则整体重试 ──
    let lastMessage = '';
    for (let attempt = 0; attempt <= config.maxPushRetries; attempt++) {
      const integrate = await this.fetchAndIntegrate();
      if (integrate) {
        return { ...integrate, committed };
      }

      const push = await this.push();
      if (!push.rejected) {
        if (push.failed) {
          return makeOutcome({
            status: 'failed',
            message: `推送失败：${push.message}`,
            committed,
          });
        }
        const counts = await this.aheadBehind();
        const idle = !committed && counts.ahead === 0 && counts.behind === 0;
        return makeOutcome({
          status: idle ? 'up-to-date' : 'ok',
          message: idle ? '本地与远端一致' : push.message || '同步完成',
          ahead: counts.ahead,
          behind: counts.behind,
          committed,
          pushed: true,
        });
      }

      lastMessage = push.message;
      this.log('warn', `推送被拒（第 ${attempt + 1} 次），重新拉取后重试：${push.message}`);
    }

    return makeOutcome({
      status: 'failed',
      message: `推送持续被拒（已重试 ${config.maxPushRetries} 次）：${lastMessage}`,
      committed,
    });
  }

  /**
   * fetch + 整合远端。
   * 返回 null 表示"已整合完毕，可以继续推送"；返回 outcome 表示本轮应当直接结束。
   */
  private async fetchAndIntegrate(): Promise<SyncOutcome | null> {
    const { runner, config } = this;
    const remoteRef = `origin/${config.branch}`;

    const fetch = await runner.run(['fetch', 'origin', config.branch, '--prune'], {
      timeoutMs: config.fetchTimeoutMs,
    });

    if (fetch.failed) {
      if (looksMissingRemoteRef(fetch.stderr) || looksMissingRemoteRef(fetch.stdout)) {
        // 远端还没有这个分支 —— 属于首次推送，不算错误
        this.log('info', `远端分支 ${config.branch} 尚不存在，将执行首次推送`);
        return null;
      }
      const counts = await this.aheadBehind();
      return makeOutcome({
        status: 'offline',
        message: `拉取失败，本地提交已保留：${firstLine(fetch.stderr) || firstLine(fetch.stdout)}`,
        ahead: counts.ahead,
        behind: counts.behind,
      });
    }

    const hasRemote = await remoteBranchExists(runner, config.branch);
    const localHead = await runner.run(['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (localHead.failed || localHead.stdout.trim().length === 0) {
      // 本地还没有任何提交
      return null;
    }

    if (!hasRemote) {
      return null;
    }

    const remoteHead = (await runner.run(['rev-parse', remoteRef])).stdout.trim();
    const local = localHead.stdout.trim();

    if (local === remoteHead) {
      return null;
    }

    if (await this.isAncestor(local, remoteHead)) {
      // 仅落后 → 快进
      const merge = await runner.run(['merge', '--ff-only', remoteRef], {
        timeoutMs: config.defaultTimeoutMs,
      });
      if (merge.failed) {
        return makeOutcome({
          status: 'failed',
          message: `快进合并失败：${firstLine(merge.stderr)}`,
        });
      }
      return null;
    }

    if (await this.isAncestor(remoteHead, local)) {
      // 仅领先 → 直接推送
      return null;
    }

    // ── 已分叉：先建兜底锚点，再合并 ──
    const anchor = `refs/heads/conflict/${timestamp()}`;
    const ref = await runner.run(['update-ref', anchor, 'HEAD']);
    if (ref.failed) {
      // 宁可不同步，也不做没有兜底的合并
      return makeOutcome({
        status: 'failed',
        message: `建立备份引用失败，已中止合并：${firstLine(ref.stderr)}`,
      });
    }
    this.log('info', `已在 ${anchor} 保存合并前状态`);

    const merge = await runner.run(['merge', '--no-edit', remoteRef], {
      timeoutMs: config.defaultTimeoutMs,
    });

    if (!merge.failed) {
      return null;
    }

    const report = await resolveConflicts(runner, {
      configDir: config.configDir,
      deviceName: config.deviceName,
      autoResolveConfigFiles: config.autoResolveConfigFiles,
      keepConflictCopies: config.keepConflictCopies,
    });

    const blocking = [...report.needsManual, ...report.failed];

    if (blocking.length > 0) {
      this.hooks.onConflict?.(blocking);
      return makeOutcome({
        status: 'conflict',
        message:
          `${blocking.length} 个文件需要手工解决冲突` +
          (report.copies.length > 0 ? `，对方版本已另存为 ${report.copies.length} 份副本` : ''),
        conflicts: blocking,
      });
    }

    // 冲突全部自动解决 → 完成这次合并
    const finish = await runner.run(['commit', '--no-edit']);
    if (finish.failed) {
      return makeOutcome({
        status: 'failed',
        message: `结束合并失败：${firstLine(finish.stderr)}`,
      });
    }
    this.log('info', `自动解决 ${report.autoResolved.length} 个冲突文件后完成合并`);
    return null;
  }

  private async push(): Promise<{ failed: boolean; rejected: boolean; message: string }> {
    const { runner, config } = this;
    const result = await runner.run(
      ['push', 'origin', `HEAD:refs/heads/${config.branch}`],
      { timeoutMs: config.pushTimeoutMs }
    );

    if (!result.failed) {
      return { failed: false, rejected: false, message: '已推送到远端' };
    }

    const combined = `${result.stderr}\n${result.stdout}`;
    if (looksRejected(combined)) {
      return { failed: true, rejected: true, message: firstLine(result.stderr) };
    }
    if (result.timedOut) {
      return { failed: true, rejected: false, message: '推送超时' };
    }
    return { failed: true, rejected: false, message: firstLine(result.stderr) || '推送失败' };
  }

  private async isAncestor(maybeAncestor: string, descendant: string): Promise<boolean> {
    const result = await this.runner.run(['merge-base', '--is-ancestor', maybeAncestor, descendant]);
    return !result.failed;
  }

  /** 只读地计算 ahead/behind，供状态栏使用 */
  async aheadBehind(): Promise<{ ahead: number; behind: number }> {
    const { runner, config } = this;
    const result = await runner.run([
      'rev-list',
      '--left-right',
      '--count',
      `HEAD...origin/${config.branch}`,
    ]);
    if (result.failed) {
      return { ahead: 0, behind: 0 };
    }
    const [ahead, behind] = result.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    return {
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
  }

  /** 提交身份缺失时补一份仓库级默认值，让插件开箱可用 */
  private async ensureIdentity(): Promise<boolean> {
    const { runner, config } = this;
    const email = await runner.run(['config', '--get', 'user.email']);
    if (!email.failed && email.stdout.trim().length > 0) {
      return true;
    }
    const name = await runner.run(['config', 'user.name', config.deviceName]);
    const mail = await runner.run(['config', 'user.email', `${config.deviceName}@localhost`]);
    this.log('warn', '未检测到 git 提交身份，已写入仓库级默认值（user.name / user.email）');
    return !name.failed && !mail.failed;
  }
}
