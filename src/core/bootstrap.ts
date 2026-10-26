import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GitRunner } from './git-runner';

/**
 * 仓库初始化与守卫。
 *
 * 职责：把"一个普通文件夹"变成"一个配置正确的、可安全同步的 git 仓库"，
 * 并保证每次同步前那些**本地配置**（merge 驱动、冲突风格）确实存在 ——
 * 因为它们写在 .git/config 里，不会被推送到远端，换设备必须重新写。
 */

export const MERGE_DRIVER_NAME = 'ours';

export function gitignoreTemplate(configDir: string): string {
  return `# ── Obsidian 运行时噪音：每次打开文件/切换面板都会变，同步它只会制造无意义提交与冲突 ──
${configDir}/workspace.json
${configDir}/workspace-mobile.json
${configDir}/graph.json

# 插件目录整体忽略。这里没有任何值得同步的东西：
#   · main.js 是几 MB 的构建产物，每次插件更新都会让仓库膨胀一次（纯噪音）
#   · data.json 明文保存着插件 Token / 私钥，提交即泄密
#   · 插件清单由 ${configDir}/community-plugins.json 记录，新设备据此安装即可
${configDir}/plugins/

# ── Obsidian 回收站 ──
.trash/

# ── 冲突副本（由插件生成，本身不参与同步，避免冲突扩散） ──
*.conflict-*

# ── 系统垃圾文件 ──
.DS_Store
Thumbs.db
desktop.ini
`;
}

export function gitattributesTemplate(configDir: string): string {
  return `# 文本文件统一按 LF 存储，避免跨平台换行符造成整文件冲突
* text=auto eol=lf

# Markdown 走 git 默认的三方行级合并
*.md merge=merge

# 二进制附件必须显式声明：否则 git 会把冲突标记写进二进制文件，直接损坏文件
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.webp binary
*.bmp binary
*.ico binary
*.pdf binary
*.zip binary
*.gz binary
*.7z binary
*.mp3 binary
*.wav binary
*.m4a binary
*.mp4 binary
*.mov binary
*.canvas binary

# 高频变动的配置类文件：冲突时无条件保留本地版本（依赖 merge.ours 驱动）
${configDir}/*.json merge=${MERGE_DRIVER_NAME}
`;
}

/** 缺失则整份写入；已存在则只补齐缺失的行，绝不覆盖用户自己的规则 */
async function mergeFile(filePath: string, template: string): Promise<boolean> {
  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch {
    await fs.writeFile(filePath, template, 'utf8');
    return true;
  }

  const existingLines = new Set(
    existing
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  );

  const missing = template
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#') && !existingLines.has(trimmed);
    });

  if (missing.length === 0) {
    return false;
  }

  const separator = existing.endsWith('\n') ? '' : '\n';
  await fs.writeFile(
    filePath,
    `${existing}${separator}\n# ── 以下由 GitHub Vault Sync (Desktop) 自动补充 ──\n${missing.join('\n')}\n`,
    'utf8'
  );
  return true;
}

export interface BootstrapReport {
  initialized: boolean;
  remoteConfigured: boolean;
  remoteChanged: boolean;
  mergeDriverRegistered: boolean;
  conflictStyleSet: boolean;
  gitignoreWritten: boolean;
  gitattributesWritten: boolean;
  warnings: string[];
}

export interface EnsureRepoOptions {
  remoteUrl: string;
  branch: string;
  configDir: string;
}

/** 判断当前目录是否已经是一个 git 工作区 */
export async function isGitRepo(runner: GitRunner): Promise<boolean> {
  const result = await runner.run(['rev-parse', '--is-inside-work-tree']);
  return !result.failed && result.stdout.trim() === 'true';
}

/** 是否处于"合并未完成"状态（有 MERGE_HEAD） */
export async function isMergeInProgress(runner: GitRunner): Promise<boolean> {
  const result = await runner.run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  return !result.failed && result.stdout.trim().length > 0;
}

async function currentRemote(runner: GitRunner): Promise<string | null> {
  const result = await runner.run(['remote', 'get-url', 'origin']);
  if (result.failed) {
    return null;
  }
  const url = result.stdout.trim();
  return url.length > 0 ? url : null;
}

/**
 * 保证仓库处于可同步状态。幂等：可以每轮同步前调用。
 */
export async function ensureRepo(runner: GitRunner, options: EnsureRepoOptions): Promise<BootstrapReport> {
  const report: BootstrapReport = {
    initialized: false,
    remoteConfigured: false,
    remoteChanged: false,
    mergeDriverRegistered: false,
    conflictStyleSet: false,
    gitignoreWritten: false,
    gitattributesWritten: false,
    warnings: [],
  };

  if (!(await isGitRepo(runner))) {
    const init = await runner.run(['init', '-b', options.branch]);
    if (init.failed) {
      // 老版本 git 不支持 -b
      const fallback = await runner.run(['init']);
      if (fallback.failed) {
        report.warnings.push(`git init 失败：${init.stderr || fallback.stderr}`);
        return report;
      }
      await runner.run(['symbolic-ref', 'HEAD', `refs/heads/${options.branch}`]);
    }
    report.initialized = true;
  }

  const remote = await currentRemote(runner);
  if (options.remoteUrl.trim().length === 0) {
    // 只做本地版本控制，尚未绑定远端。不算错误，但要明确告知。
    report.remoteConfigured = true;
    report.warnings.push('尚未配置远端仓库地址，当前仅启用本地版本控制');
  } else if (remote === null) {
    const add = await runner.run(['remote', 'add', 'origin', options.remoteUrl]);
    if (add.failed) {
      report.warnings.push(`配置远端失败：${add.stderr}`);
    } else {
      report.remoteConfigured = true;
    }
  } else if (remote !== options.remoteUrl) {
    const set = await runner.run(['remote', 'set-url', 'origin', options.remoteUrl]);
    if (set.failed) {
      report.warnings.push(`更新远端地址失败：${set.stderr}`);
    } else {
      report.remoteConfigured = true;
      report.remoteChanged = true;
    }
  } else {
    report.remoteConfigured = true;
  }

  // merge=ours 不是 git 内置驱动，必须先注册；这个配置只存在于 .git/config，
  // 不会随推送传播，所以换设备必须重新写 —— 因此每轮都校验一次。
  const driver = await runner.run(['config', `merge.${MERGE_DRIVER_NAME}.driver`, 'true']);
  report.mergeDriverRegistered = !driver.failed;

  const style = await runner.run(['config', 'merge.conflictStyle', 'zdiff3']);
  report.conflictStyleSet = !style.failed;

  const root = runner.cwd;
  report.gitignoreWritten = await mergeFile(path.join(root, '.gitignore'), gitignoreTemplate(options.configDir));
  report.gitattributesWritten = await mergeFile(
    path.join(root, '.gitattributes'),
    gitattributesTemplate(options.configDir)
  );

  // 已经推送过、又被新加进 .gitignore 的敏感文件，光加规则是无效的，
  // 必须从索引里摘掉（保留工作区文件）。
  const tracked = await runner.run([
    'ls-files',
    '--error-unmatch',
    `${options.configDir}/plugins`,
  ]);
  if (!tracked.failed && tracked.stdout.trim().length > 0) {
    report.warnings.push(
      `检测到 ${options.configDir}/plugins 下已有文件被 git 跟踪。` +
        `这些文件可能包含插件 Token，建议执行 git rm -r --cached "${options.configDir}/plugins" 后提交。`
    );
  }

  return report;
}

/** 检查远端分支是否已存在（用于区分"首次推送"与"常规同步"） */
export async function remoteBranchExists(runner: GitRunner, branch: string): Promise<boolean> {
  const result = await runner.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  return !result.failed && result.stdout.trim().length > 0;
}
