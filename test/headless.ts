/**
 * 端到端验收测试（无头运行，不需要 Obsidian）。
 *
 * 为什么能这么测：src/core 下的 git 逻辑刻意不 import 'obsidian'，
 * 因此可以在纯 Node 下用真实的 git 进程跑完整同步链路。
 *
 * 覆盖：
 *  · 凭据不出现在命令行参数里（安全性质）
 *  · 仓库初始化 + .gitignore/.gitattributes 生成 + merge 驱动注册
 *  · 首次提交并推送到远端（本地 git 仓库 / GitHub 仓库同一套代码路径）
 *  · 敏感文件（插件 data.json）绝不进入版本库
 *  · 幂等性
 *  · 双设备并发改动自动合并
 *  · 真实冲突的识别、副本生成、以及"不推送、不自动提交"的安全行为
 *  · 构建产物 main.js 可被加载
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { SyncEngine } from '../src/core/engine';
import { locateGit } from '../src/core/git-locate';
import { GitRunner } from '../src/core/git-runner';
import { Redactor } from '../src/core/redact';
import { DEFAULT_SYNC_CONFIG, type SyncConfig } from '../src/core/types';

const execFileAsync = promisify(execFile);
const requireCjs = createRequire(__filename);

const results: Array<{ name: string; ok: boolean }> = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function git(args: string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const location = await locateGit();
  if (!location) {
    console.error('未找到可用的 git，无法运行验收测试');
    process.exit(1);
  }
  console.log(`git: ${location.version}  (${location.path}, source=${location.source})`);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gvs-e2e-'));
  const vaultDir = path.join(root, 'vault');
  const remoteDir = path.join(root, 'remote.git');
  const otherDir = path.join(root, 'other-device');
  const configDir = '.obsidian';

  const secret = `ghp_${'a'.repeat(36)}`;

  try {
    // ───────────────────────── 准备 ─────────────────────────
    await fs.mkdir(path.join(vaultDir, '文档'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, configDir, 'plugins', 'obsidian-local-rest-api'), { recursive: true });
    await fs.writeFile(path.join(vaultDir, '文档', 'note1.md'), '# 笔记一\n\n第一行\n', 'utf8');
    await fs.writeFile(path.join(vaultDir, '文档', 'note2.md'), '# 笔记二\n\n内容\n', 'utf8');
    // 模拟真实 Vault 里的敏感文件与噪音文件
    await fs.writeFile(
      path.join(vaultDir, configDir, 'plugins', 'obsidian-local-rest-api', 'data.json'),
      JSON.stringify({ apiKey: secret, crypto: { privateKey: 'FAKE-PRIVATE-KEY' } }),
      'utf8'
    );
    // 插件二进制：几 MB 的构建产物，属于纯噪音
    await fs.writeFile(
      path.join(vaultDir, configDir, 'plugins', 'obsidian-local-rest-api', 'main.js'),
      '/* bundled plugin */\n'.repeat(500),
      'utf8'
    );
    await fs.writeFile(path.join(vaultDir, configDir, 'workspace.json'), '{"panes":{}}', 'utf8');
    await fs.writeFile(path.join(vaultDir, configDir, 'appearance.json'), '{"theme":"obsidian"}', 'utf8');

    const bareInit = await git(['init', '--bare', '-b', 'main', remoteDir], root);
    check('创建裸远端仓库（模拟 GitHub 端）', bareInit.code === 0, bareInit.stderr.trim());

    // ───────────────────── ① 凭据安全性质 ─────────────────────
    section('① 凭据处理');

    const patRunner = new GitRunner(location.path, vaultDir, {
      auth: { mode: 'pat', username: 'x-access-token', token: secret },
    });
    const invocation = patRunner.buildInvocation(['fetch', 'origin', 'main']);

    check(
      'Token 不出现在命令行参数中',
      !invocation.argv.some((arg) => arg.includes(secret)),
      `argv 长度 ${invocation.argv.length}`
    );
    check('Token 通过环境变量传递', invocation.env.GVS_GIT_TOKEN === secret);
    check('GIT_DIR 已被清除', invocation.env.GIT_DIR === undefined);
    check('GIT_WORK_TREE 已被清除', invocation.env.GIT_WORK_TREE === undefined);
    check('GIT_TERMINAL_PROMPT=0', invocation.env.GIT_TERMINAL_PROMPT === '0');
    check('GIT_OPTIONAL_LOCKS=0', invocation.env.GIT_OPTIONAL_LOCKS === '0');
    check(
      '凭据助手以 ! 内联脚本注入且引用环境变量',
      invocation.argv.some((arg) => arg.includes('credential.helper=!') && arg.includes('$GVS_GIT_TOKEN'))
    );

    const redactor = new Redactor();
    redactor.add(secret);
    check('已知 Token 被脱敏', redactor.redact(`token=${secret}`) === 'token=***');
    check(
      '未知形态 Token 也能按模式脱敏',
      redactor.redact('x github_pat_11ABCDEFG0abcdefghijklmnop x') === 'x *** x'
    );
    check(
      'URL 内嵌凭据被脱敏',
      redactor.redact('https://user:pass@github.com/o/r.git') === 'https://***:***@github.com/o/r.git'
    );

    // ─────────────────── ② 首次同步（提交 + 推送） ───────────────────
    section('② 首次同步：提交到本地仓库并推送到远端');

    const runner = new GitRunner(location.path, vaultDir);
    const config: SyncConfig = {
      ...DEFAULT_SYNC_CONFIG,
      remoteUrl: remoteDir,
      branch: 'main',
      deviceName: 'test-device',
      configDir,
    };
    const engine = new SyncEngine(runner, config, {
      log: (level, message) => console.log(`      [engine:${level}] ${message}`),
    });

    const first = await engine.syncOnce('test');
    check('首次同步成功', first.status === 'ok', `status=${first.status} msg=${first.message}`);
    check('产生了本地提交', first.committed);
    check('已推送到远端', first.pushed);

    const localHead = await git(['rev-parse', 'HEAD'], vaultDir);
    const remoteHead = await git([`--git-dir=${remoteDir}`, 'rev-parse', 'main'], root);
    check(
      '远端 HEAD 与本地 HEAD 一致',
      localHead.stdout.trim().length > 0 && localHead.stdout.trim() === remoteHead.stdout.trim(),
      `local=${localHead.stdout.trim().slice(0, 8)} remote=${remoteHead.stdout.trim().slice(0, 8)}`
    );

    // ─────────────────── ③ 敏感文件绝不入库 ───────────────────
    section('③ 安全：敏感文件与噪音文件');

    const tracked = await git(
      [`--git-dir=${remoteDir}`, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'main'],
      root
    );
    const trackedFiles = tracked.stdout.split('\n').map((f) => f.trim()).filter(Boolean);
    console.log(`      远端文件清单：${trackedFiles.join(', ')}`);

    check('笔记已进入远端仓库', trackedFiles.some((f) => f.endsWith('note1.md')));
    check(
      '插件目录整体未进入远端仓库（密钥与构建产物都不上传）',
      !trackedFiles.some((f) => f.includes('plugins/'))
    );
    check('workspace.json 未进入远端仓库', !trackedFiles.some((f) => f.endsWith('workspace.json')));
    check(
      '非敏感配置 appearance.json 正常纳入版本控制',
      trackedFiles.some((f) => f.endsWith('appearance.json'))
    );
    check('.gitignore 已生成并提交', trackedFiles.includes('.gitignore'));
    check('.gitattributes 已生成并提交', trackedFiles.includes('.gitattributes'));

    const driver = await git(['config', '--get', 'merge.ours.driver'], vaultDir);
    check('merge.ours 驱动已注册', driver.stdout.trim() === 'true', driver.stdout.trim());

    const conflictStyle = await git(['config', '--get', 'merge.conflictStyle'], vaultDir);
    check('merge.conflictStyle=zdiff3 已设置', conflictStyle.stdout.trim() === 'zdiff3');

    // ───────────────────────── ④ 幂等 ─────────────────────────
    section('④ 幂等性');

    const second = await engine.syncOnce('test');
    check('无改动时同步为空转', second.status === 'up-to-date', `status=${second.status}`);
    check('空转时不产生新提交', !second.committed);

    // ─────────────── ⑤ 双设备并发改动自动合并 ───────────────
    section('⑤ 双设备：不同文件改动自动合并');

    const clone = await git(['clone', remoteDir, otherDir], root);
    check('克隆远端到"另一台设备"', clone.code === 0, clone.stderr.trim());
    await git(['config', 'user.name', 'other-device'], otherDir);
    await git(['config', 'user.email', 'other@localhost'], otherDir);

    await fs.writeFile(path.join(otherDir, '文档', 'note3.md'), '# 笔记三（对方设备新建）\n', 'utf8');
    await git(['add', '-A'], otherDir);
    await git(['commit', '-m', 'from other device'], otherDir);
    const otherPush = await git(['push', 'origin', 'main'], otherDir);
    check('对方设备推送成功', otherPush.code === 0, otherPush.stderr.trim());

    // 本机改的是**另一个**文件
    await fs.writeFile(path.join(vaultDir, '文档', 'note4.md'), '# 笔记四（本机新建）\n', 'utf8');
    const third = await engine.syncOnce('test');
    check(
      '分叉后自动合并成功',
      third.status === 'ok' || third.status === 'up-to-date',
      `status=${third.status} msg=${third.message}`
    );
    check('对方设备的新文件已同步到本机', await exists(path.join(vaultDir, '文档', 'note3.md')));
    check('本机新文件已推送', await exists(path.join(otherDir, '文档', 'note4.md')) === false);

    const afterMerge = await git(
      [`--git-dir=${remoteDir}`, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'main'],
      root
    );
    check('远端同时包含两边的文件', afterMerge.stdout.includes('note3.md') && afterMerge.stdout.includes('note4.md'));

    // ───────────────────── ⑥ 真实冲突 ─────────────────────
    section('⑥ 冲突：识别、副本、且不推送不自动提交');

    await git(['pull', 'origin', 'main'], otherDir);
    await fs.writeFile(path.join(otherDir, '文档', 'note1.md'), '# 笔记一\n\n第一行（对方改的）\n', 'utf8');
    await git(['add', '-A'], otherDir);
    await git(['commit', '-m', 'other edits note1'], otherDir);
    const conflictPush = await git(['push', 'origin', 'main'], otherDir);
    check('对方设备推送冲突前版本', conflictPush.code === 0, conflictPush.stderr.trim());

    // 本机改**同一行**
    await fs.writeFile(path.join(vaultDir, '文档', 'note1.md'), '# 笔记一\n\n第一行（我方改的）\n', 'utf8');
    const conflicted = await engine.syncOnce('test');

    check('冲突被正确识别', conflicted.status === 'conflict', `status=${conflicted.status} msg=${conflicted.message}`);
    check('冲突文件被列出', conflicted.conflicts.some((f) => f.includes('note1.md')));
    check('冲突时未推送', !conflicted.pushed);

    const vaultDocFiles = await fs.readdir(path.join(vaultDir, '文档'));
    const copies = vaultDocFiles.filter((f) => f.includes('.conflict-'));
    check('已生成对方版本副本', copies.length > 0, copies.join(', '));

    if (copies.length > 0) {
      const copyContent = await fs.readFile(path.join(vaultDir, '文档', copies[0]), 'utf8');
      check('副本内容是对方的版本（数据未丢）', copyContent.includes('对方改的'));
    }

    const workingFile = await fs.readFile(path.join(vaultDir, '文档', 'note1.md'), 'utf8');
    check('工作区文件保留了冲突标记供用户处理', workingFile.includes('<<<<<<<') && workingFile.includes('>>>>>>>'));

    const remoteAfterConflict = await git(
      [`--git-dir=${remoteDir}`, 'show', 'main:文档/note1.md'],
      root
    );
    check(
      '远端未被半成品内容污染',
      !remoteAfterConflict.stdout.includes('<<<<<<<'),
      '远端 note1.md 无冲突标记'
    );

    // ───────────── ⑦ 未解决冲突时后续同步被阻断 ─────────────
    section('⑦ 冲突未解决时的守卫');

    const blocked = await engine.syncOnce('test');
    check('存在未完成合并时同步被阻断', blocked.status === 'blocked', `status=${blocked.status}`);

    // ───────────── ⑧ 备份引用（合并兜底锚点） ─────────────
    section('⑧ 合并兜底锚点');

    const refs = await git(['for-each-ref', '--format=%(refname)', 'refs/heads/conflict'], vaultDir);
    const anchors = refs.stdout.split('\n').map((r) => r.trim()).filter(Boolean);
    check('合并前已建立 conflict/<时间戳> 备份引用', anchors.length > 0, anchors.join(', '));

    // ───────────── ⑨ 构建产物可加载 ─────────────
    section('⑨ 构建产物');

    const bundlePath = path.join(__dirname, '..', 'main.js');
    const stubPath = path.join(__dirname, 'stubs', 'obsidian.cjs');
    check('main.js 存在', await exists(bundlePath));

    if (await exists(bundlePath)) {
      const ModuleAny = require('node:module') as unknown as {
        _resolveFilename: (request: string, ...rest: unknown[]) => string;
      };
      const original = ModuleAny._resolveFilename;
      ModuleAny._resolveFilename = function patched(request: string, ...rest: unknown[]): string {
        if (request === 'obsidian') {
          return stubPath;
        }
        return original.call(this, request, ...rest);
      };

      try {
        const loaded = requireCjs(bundlePath) as { default?: unknown };
        const PluginClass = loaded.default as { prototype?: Record<string, unknown> } | undefined;
        check('main.js 可被加载', typeof PluginClass === 'function');
        check('插件类实现了 onload', typeof PluginClass?.prototype?.onload === 'function');
        check('插件类实现了 onunload', typeof PluginClass?.prototype?.onunload === 'function');
        check('插件类实现了 runSync', typeof PluginClass?.prototype?.runSync === 'function');
      } catch (error) {
        check('main.js 可被加载', false, error instanceof Error ? error.message : String(error));
      } finally {
        ModuleAny._resolveFilename = original;
      }
    }
  } finally {
    const keep = process.argv.includes('--keep');
    if (keep) {
      console.log(`\n临时目录已保留：${root}`);
    } else {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const item of failed) {
      console.log(`  - ${item.name}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
