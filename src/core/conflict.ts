import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GitRunner } from './git-runner';

/**
 * 冲突处理。
 *
 * 分流规则（设计文档 3.4.1）：
 *  - 配置目录下的 *.json  → 保留本地（理论上已由 merge=ours 驱动自动处理）
 *  - 二进制附件          → 保留我方版本 + 对方版本另存为副本（二进制无法行级合并）
 *  - 文本文件            → **保持冲突态交给用户**，不自动提交、不自动推送
 *
 * 文本文件绝不自动 git add：把带冲突标记的内容自动提交上去，
 * 等于把"半成品"当成正常内容同步给其他设备。
 */

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff',
  '.pdf', '.zip', '.gz', '.7z', '.rar', '.tar',
  '.mp3', '.wav', '.m4a', '.flac', '.ogg',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin',
]);

export function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function sanitizeDeviceName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 32) : 'device';
}

export function timestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function conflictCopyPath(filePath: string, device: string, stamp: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `${base}.conflict-${sanitizeDeviceName(device)}-${stamp}${ext}`);
}

/**
 * 列出未合并路径。
 * 用 ls-files -u 而不是解析 status 输出：前者直接给出索引里的 stage 1/2/3 条目，
 * 语义明确，且不受 porcelain 格式细节影响。
 */
export async function listUnmerged(runner: GitRunner): Promise<string[]> {
  const result = await runner.run(['ls-files', '-u', '-z']);
  if (result.failed || result.stdout.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  for (const record of result.stdout.split('\0')) {
    if (!record) {
      continue;
    }
    const tabIndex = record.indexOf('\t');
    if (tabIndex === -1) {
      continue;
    }
    seen.add(record.slice(tabIndex + 1));
  }
  return [...seen].sort();
}

export type ConflictStrategy = 'keep-ours' | 'keep-ours-with-copy' | 'needs-manual';

export interface ResolvedConflict {
  filePath: string;
  strategy: ConflictStrategy;
  copyPath?: string;
}

export interface ConflictReport {
  /** 已自动解决并 git add 的文件 */
  autoResolved: ResolvedConflict[];
  /** 生成的对方版本副本（绝对路径） */
  copies: string[];
  /** 需要用户手工处理的文件（保持冲突态） */
  needsManual: string[];
  /** 处理失败的文件 */
  failed: string[];
}

export interface ResolveOptions {
  configDir: string;
  deviceName: string;
  autoResolveConfigFiles: boolean;
  keepConflictCopies: boolean;
}

function isConfigFile(filePath: string, configDir: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const prefix = `${configDir.replace(/\\/g, '/')}/`;
  return normalized.startsWith(prefix) && normalized.toLowerCase().endsWith('.json');
}

/**
 * 处理工作区里所有未合并文件。
 * 调用方根据 needsManual 是否为空决定"完成合并并推送"还是"挂起等用户"。
 */
export async function resolveConflicts(
  runner: GitRunner,
  options: ResolveOptions
): Promise<ConflictReport> {
  const report: ConflictReport = { autoResolved: [], copies: [], needsManual: [], failed: [] };
  const files = await listUnmerged(runner);
  const stamp = timestamp();

  for (const filePath of files) {
    const absolute = path.join(runner.cwd, filePath);

    let exists = true;
    try {
      await fs.access(absolute);
    } catch {
      exists = false;
    }

    // 文件在工作区不存在（例如"我方删除 / 对方修改"），无法自动判定，交给用户
    if (!exists) {
      report.needsManual.push(filePath);
      continue;
    }

    const configFile = isConfigFile(filePath, options.configDir);
    const binary = isBinaryPath(filePath);

    if (configFile && options.autoResolveConfigFiles) {
      const checkout = await runner.run(['checkout', '--ours', '--', filePath]);
      if (checkout.failed) {
        report.failed.push(filePath);
        continue;
      }
      const add = await runner.run(['add', '--', filePath]);
      if (add.failed) {
        report.failed.push(filePath);
        continue;
      }
      report.autoResolved.push({ filePath, strategy: 'keep-ours' });
      continue;
    }

    if (!binary) {
      // 文本文件：保持冲突态。可选地先把对方版本留一份副本，避免用户误删冲突标记后丢数据。
      if (options.keepConflictCopies) {
        const copy = await writeTheirsCopy(runner, filePath, options.deviceName, stamp);
        if (copy) {
          report.copies.push(copy);
        }
      }
      report.needsManual.push(filePath);
      continue;
    }

    // 二进制：工作区保留我方版本，对方版本另存副本
    const checkout = await runner.run(['checkout', '--ours', '--', filePath]);
    if (checkout.failed) {
      report.failed.push(filePath);
      continue;
    }
    let copyPath: string | undefined;
    if (options.keepConflictCopies) {
      const copy = await writeTheirsCopy(runner, filePath, options.deviceName, stamp);
      if (copy) {
        copyPath = copy;
        report.copies.push(copy);
      }
    }
    const add = await runner.run(['add', '--', filePath]);
    if (add.failed) {
      report.failed.push(filePath);
      continue;
    }
    report.autoResolved.push({
      filePath,
      strategy: copyPath ? 'keep-ours-with-copy' : 'keep-ours',
      copyPath,
    });
  }

  return report;
}

/** 把 stage 3（theirs）的内容写成 .conflict-* 副本 */
async function writeTheirsCopy(
  runner: GitRunner,
  filePath: string,
  deviceName: string,
  stamp: string
): Promise<string | null> {
  const blob = await runner.runBuffer(['show', `:3:${filePath}`]);
  if (blob.failed || blob.stdout.length === 0) {
    return null;
  }
  const relativeCopy = conflictCopyPath(filePath, deviceName, stamp);
  const absoluteCopy = path.join(runner.cwd, relativeCopy);
  try {
    await fs.mkdir(path.dirname(absoluteCopy), { recursive: true });
    await fs.writeFile(absoluteCopy, blob.stdout);
    return absoluteCopy;
  } catch {
    return null;
  }
}
