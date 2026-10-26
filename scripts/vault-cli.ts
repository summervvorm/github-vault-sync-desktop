/**
 * 命令行驱动 —— 复用 src/core 的同一套逻辑，用于在 Obsidian 之外
 * 对真实 Vault 执行初始化、同步、状态查询与 GitHub 仓库创建。
 *
 * 这不是插件的替代品，而是它的"无头形态"：两者共用同一个 SyncEngine，
 * 因此这里跑通的行为就是插件里的行为。
 *
 * 用法：
 *   node scripts/vault-cli.cjs init        --vault <路径> [--remote <url>] [--branch main]
 *   node scripts/vault-cli.cjs sync        --vault <路径> --remote <url> [--token-file <路径>]
 *   node scripts/vault-cli.cjs status      --vault <路径> [--branch main]
 *   node scripts/vault-cli.cjs create-repo --repo <owner/name> --token-file <路径> [--vault <路径>]
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ensureRepo, isGitRepo } from '../src/core/bootstrap';
import { SyncEngine } from '../src/core/engine';
import { locateGit } from '../src/core/git-locate';
import { GitRunner } from '../src/core/git-runner';
import { DEFAULT_SYNC_CONFIG, type SyncConfig } from '../src/core/types';

function arg(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function readToken(): Promise<string> {
  const fromEnv = process.env.GVS_TOKEN ?? '';
  if (fromEnv.length > 0) {
    return fromEnv.trim();
  }
  const file = arg('token-file');
  if (file.length > 0) {
    return (await fs.readFile(file, 'utf8')).trim();
  }
  return '';
}

interface Context {
  vault: string;
  runner: GitRunner;
  config: SyncConfig;
  engine: SyncEngine;
}

async function makeContext(requireRemote = true): Promise<Context> {
  const vault = path.resolve(arg('vault', process.cwd()));
  const remote = arg('remote');
  const branch = arg('branch', 'main');
  const token = await readToken();

  if (requireRemote && remote.length === 0) {
    throw new Error('缺少 --remote 参数');
  }

  const location = await locateGit(arg('git'));
  if (!location) {
    throw new Error('未找到可用的 git，可用 --git <路径> 指定');
  }

  const runner = new GitRunner(location.path, vault, {
    auth: token.length > 0 ? { mode: 'pat', username: 'x-access-token', token } : { mode: 'credential-helper' },
  });

  const config: SyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    remoteUrl: remote,
    branch,
    deviceName: arg('device', 'cli'),
    configDir: arg('config-dir', '.obsidian'),
  };

  const engine = new SyncEngine(runner, config, {
    log: (level, message) => console.log(`  [${level}] ${message}`),
  });

  return { vault, runner, config, engine };
}

async function commandInit(): Promise<void> {
  const { vault, runner, config } = await makeContext(false);
  console.log(`Vault: ${vault}`);

  const alreadyRepo = await isGitRepo(runner);
  console.log(`已是 git 仓库：${alreadyRepo ? '是' : '否'}`);

  const report = await ensureRepo(runner, {
    remoteUrl: config.remoteUrl,
    branch: config.branch,
    configDir: config.configDir,
  });

  console.log(JSON.stringify(report, null, 2));

  // 初始化后立即提交一次本地改动（不推送）
  const status = await runner.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.stdout.length > 0) {
    await runner.run(['add', '-A']);
    const commit = await runner.run(['commit', '-m', 'chore: 初始化 Obsidian 仓库版本控制']);
    console.log(commit.failed ? `提交失败：${commit.stderr}` : '已创建首次本地提交');
  } else {
    console.log('工作区无改动，跳过提交');
  }
}

async function commandSync(): Promise<void> {
  const { engine } = await makeContext(true);
  const outcome = await engine.syncOnce('manual');
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.status === 'failed') {
    process.exitCode = 1;
  }
}

async function commandStatus(): Promise<void> {
  const { runner, engine, config } = await makeContext(false);
  const repo = await isGitRepo(runner);
  console.log(`已是 git 仓库：${repo ? '是' : '否'}`);
  if (!repo) {
    return;
  }
  const head = await runner.run(['rev-parse', '--short', 'HEAD']);
  console.log(`HEAD: ${head.failed ? '(无提交)' : head.stdout.trim()}`);
  const status = await runner.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  console.log(`未提交改动：${status.stdout.length > 0 ? '有' : '无'}`);
  const remotes = await runner.run(['remote', '-v']);
  console.log(`远端：\n${remotes.stdout.trim() || '(未配置)'}`);
  const counts = await engine.aheadBehind();
  console.log(`相对 origin/${config.branch}：ahead=${counts.ahead} behind=${counts.behind}`);
}

async function commandCreateRepo(): Promise<void> {
  const repo = arg('repo');
  if (repo.length === 0 || !repo.includes('/')) {
    throw new Error('缺少 --repo <owner/name> 参数');
  }
  const token = await readToken();
  if (token.length === 0) {
    throw new Error('缺少凭据：请用 --token-file <路径> 或环境变量 GVS_TOKEN 提供');
  }

  const name = repo.split('/')[1];
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'github-vault-sync-desktop',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  console.log(`创建私有仓库 ${repo} ...`);
  let response = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      private: true,
      description: 'Obsidian vault（由 GitHub Vault Sync (Desktop) 管理）',
      auto_init: false,
      has_issues: false,
      has_wiki: false,
    }),
  });

  if (response.status === 422) {
    // 仓库已存在 —— 取回它的地址即可
    console.log('仓库已存在，改为读取现有仓库信息');
    response = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}：${body.slice(0, 400)}`);
  }

  const data = (await response.json()) as {
    full_name: string;
    private: boolean;
    clone_url: string;
    html_url: string;
  };

  console.log(`仓库：${data.full_name}`);
  console.log(`可见性：${data.private ? 'private ✅' : 'PUBLIC ⚠️'}`);
  console.log(`地址：${data.html_url}`);
  console.log(`CLONE_URL=${data.clone_url}`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? '';
  switch (command) {
    case 'init':
      await commandInit();
      break;
    case 'sync':
      await commandSync();
      break;
    case 'status':
      await commandStatus();
      break;
    case 'create-repo':
      await commandCreateRepo();
      break;
    default:
      console.log('用法：node scripts/vault-cli.cjs <init|sync|status|create-repo> [参数]');
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
