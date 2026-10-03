import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * git 可执行文件定位。
 *
 * "git 不在 PATH 里"是同类插件最高频的用户故障（尤其是通过
 * GitHub Desktop 安装的 git，以及 macOS 上只有 Xcode CLT 的情况）。
 */

function probe(executable: string, timeoutMs = 10000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(executable, ['--version'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const text = String(stdout ?? '').trim();
      resolve(/^git version/i.test(text) ? text : null);
    });
  });
}

/** GitHub Desktop 会把 git 放在带版本号的目录里，需要枚举 */
function githubDesktopCandidates(env: NodeJS.ProcessEnv): string[] {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) {
    return [];
  }
  const root = path.join(localAppData, 'GitHubDesktop');
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith('app-'))
    .sort()
    .reverse()
    .slice(0, 5)
    .map((name) => path.join(root, name, 'resources', 'app', 'git', 'cmd', 'git.exe'));
}

export function candidateGitPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const out: string[] = [];

  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    out.push(path.join(programFiles, 'Git', 'cmd', 'git.exe'));
    out.push(path.join(programFilesX86, 'Git', 'cmd', 'git.exe'));
    if (env.LOCALAPPDATA) {
      out.push(path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'));
    }
    out.push(path.join(programFiles, 'Git', 'bin', 'git.exe'));
    out.push(...githubDesktopCandidates(env));
  } else if (platform === 'darwin') {
    out.push('/usr/bin/git');
    out.push('/opt/homebrew/bin/git');
    out.push('/usr/local/bin/git');
    out.push('/opt/local/bin/git');
  } else {
    out.push('/usr/bin/git');
    out.push('/usr/local/bin/git');
    out.push('/snap/bin/git');
    out.push('/usr/lib/git-core/git');
  }

  return out;
}

export interface GitLocation {
  path: string;
  version: string;
  source: 'configured' | 'path' | 'probed';
}

/**
 * 按 ①用户配置 → ②PATH → ③平台常见位置 的顺序定位 git。
 * 找不到时返回 null，由调用方给出可操作的引导文案。
 */
export async function locateGit(configured?: string): Promise<GitLocation | null> {
  const trimmed = (configured ?? '').trim();

  if (trimmed) {
    const version = await probe(trimmed);
    if (version) {
      return { path: trimmed, version, source: 'configured' };
    }
  }

  const fromPath = await probe('git');
  if (fromPath) {
    return { path: 'git', version: fromPath, source: 'path' };
  }

  for (const candidate of candidateGitPaths()) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const version = await probe(candidate);
    if (version) {
      return { path: candidate, version, source: 'probed' };
    }
  }

  return null;
}
