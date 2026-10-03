#!/usr/bin/env node
/**
 * 把插件源码发布到 GitHub，并创建带附件的 Release。
 *
 * 这个脚本刻意用 execFile 直接传 argv 调用 git（不经 shell），
 * 并复用与插件完全相同的凭据注入方式：credential.helper 内联脚本
 * 从环境变量读令牌。因此令牌不会进入 argv、也不会写进 .git/config。
 *
 * 用法：
 *   node scripts/publish.mjs --repo summervvorm/github-vault-sync --token-file .github-token
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
const TOKEN_ENV_KEY = 'GVS_GIT_TOKEN';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

async function readToken() {
  const fromEnv = process.env[TOKEN_ENV_KEY];
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const file = arg('token-file');
  if (file.length > 0) {
    return (await fs.readFile(file, 'utf8')).trim();
  }
  throw new Error('缺少凭据：用 --token-file <路径> 或环境变量 ' + TOKEN_ENV_KEY);
}

function headers(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'github-vault-sync-publish',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function api(method, endpoint, token, options = {}) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: headers(token, options.body ? { 'Content-Type': 'application/json' } : {}),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (options.allow404 && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${endpoint} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  if (response.status === 204) {
    return {};
  }
  return response.json();
}

function makeGit(token, cwd) {
  return async function git(args) {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_OPTIONAL_LOCKS = '0';
    env.LC_ALL = 'C';

    let argv = args;
    if (token) {
      env[TOKEN_ENV_KEY] = token;
      argv = [
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=!f() { echo username=x-access-token; echo password="$${TOKEN_ENV_KEY}"; }; f`,
        ...args,
      ];
    }

    try {
      const { stdout, stderr } = await execFileAsync('git', argv, {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
      return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (error) {
      return {
        ok: false,
        stdout: String(error.stdout ?? ''),
        stderr: String(error.stderr ?? error.message ?? ''),
      };
    }
  };
}

async function uploadAsset(token, repo, releaseId, filePath, assetName) {
  const data = await fs.readFile(filePath);
  const response = await fetch(
    `${UPLOADS}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
    {
      method: 'POST',
      headers: headers(token, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.length),
      }),
      body: data,
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`上传 ${assetName} 失败 ${response.status}: ${text.slice(0, 300)}`);
  }
  const asset = await response.json();
  return { name: asset.name, size: asset.size, url: asset.browser_download_url };
}

async function main() {
  const token = await readToken();
  const repo = arg('repo', 'summervvorm/github-vault-sync');
  const dir = path.resolve(arg('dir', process.cwd()));
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error('--repo 必须是 owner/name 形式');
  }

  const me = await api('GET', '/user', token);
  console.log(`GitHub 账号: ${me.login} (id ${me.id})`);

  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  const redo = flag('redo');

  // ── 1. 确保仓库存在，且必须是 public ──
  let info = await api('GET', `/repos/${repo}`, token, { allow404: true });
  if (!info) {
    info = await api('POST', '/user/repos', token, {
      body: {
        name,
        private: false,
        description: 'Sync your Obsidian vault with a GitHub repository. Desktop-only Obsidian plugin.',
        homepage: '',
        has_issues: true,
        has_wiki: false,
        has_projects: false,
        auto_init: false,
      },
    });
    console.log(`已创建仓库: ${info.full_name}  (private=${info.private})`);
  } else {
    console.log(`仓库已存在: ${info.full_name}  (private=${info.private})`);
    if (info.private) {
      info = await api('PATCH', `/repos/${repo}`, token, { body: { private: false } });
      console.log(`已改为 public: private=${info.private}`);
    }
  }
  if (info.private) {
    throw new Error('仓库仍是 private，中止');
  }

  // ── 2. 初始化本地仓库并推送 ──
  const git = makeGit(token, dir);

  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    const init = await git(['init', '-b', 'main']);
    if (!init.ok) {
      throw new Error(`git init 失败: ${init.stderr}`);
    }
    console.log('已初始化本地 git 仓库');
  }

  const noreply = `${me.id}+${me.login}@users.noreply.github.com`;
  await git(['config', 'user.name', me.login]);
  await git(['config', 'user.email', noreply]);
  console.log(`提交身份: ${me.login} <${noreply}>`);

  const remoteUrl = `https://github.com/${repo}.git`;
  const existingRemote = await git(['remote', 'get-url', 'origin']);
  if (!existingRemote.ok) {
    await git(['remote', 'add', 'origin', remoteUrl]);
  } else if (existingRemote.stdout.trim() !== remoteUrl) {
    await git(['remote', 'set-url', 'origin', remoteUrl]);
  }

  // --redo：把已发布的 Release 与 tag 撤掉，改写最后一个提交后重新发布。
  // 只在仓库刚建立、无人克隆时使用。
  if (redo) {
    const oldRelease = await api('GET', `/repos/${repo}/releases/tags/${version}`, token, { allow404: true });
    if (oldRelease) {
      await api('DELETE', `/repos/${repo}/releases/${oldRelease.id}`, token);
      console.log(`已删除旧 Release ${version} (id ${oldRelease.id})`);
    }
    await api('DELETE', `/repos/${repo}/git/refs/tags/${version}`, token, { allow404: true });
    console.log(`已删除旧 tag ${version}`);
  }

  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.stdout.length > 0) {
    const add = await git(['add', '-A']);
    if (!add.ok) {
      throw new Error(`git add 失败: ${add.stderr}`);
    }
    const commitArgs = redo
      ? ['commit', '--amend', '--no-edit']
      : ['commit', '-m', arg('message', 'Initial commit')];
    const commit = await git(commitArgs);
    if (!commit.ok) {
      throw new Error(`git commit 失败: ${commit.stderr}`);
    }
    console.log(redo ? '已改写上一个提交' : '已创建提交');
  } else {
    console.log('工作区无改动，跳过提交');
  }

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main';
  if (redo) {
    // 刷新远端跟踪引用，让 --force-with-lease 有准确的比较基准
    await git(['fetch', 'origin']);
  }
  const pushArgs = redo
    ? ['push', '--force-with-lease', '-u', 'origin', `${branch}:${branch}`]
    : ['push', '-u', 'origin', `${branch}:${branch}`];
  const push = await git(pushArgs);
  if (!push.ok) {
    throw new Error(`git push 失败: ${push.stderr}`);
  }
  console.log(`已推送${redo ? '（强制，带 lease 保护）' : ''}到 ${remoteUrl} (${branch})`);

  // 确认远端没有拿到令牌
  const remoteCheck = await git(['remote', '-v']);
  if (remoteCheck.stdout.includes(token)) {
    throw new Error('远端地址中出现了令牌，中止');
  }

  // ── 3. 创建 Release 并上传附件 ──
  const tag = version;

  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();

  let release = await api('GET', `/repos/${repo}/releases/tags/${tag}`, token, { allow404: true });
  if (!release) {
    release = await api('POST', `/repos/${repo}/releases`, token, {
      body: {
        tag_name: tag,
        target_commitish: head,
        name: version,
        draft: false,
        prerelease: false,
        body: [
          `Initial release of **${manifest.name}**.`,
          '',
          'Sync your Obsidian vault with a GitHub repository. The vault root *is* the Git working tree — no export, no conversion.',
          '',
          '### Highlights',
          '',
          '- Commits, fetches, three-way merges, and pushes in one safe sequence',
          '- Never force-pushes; a rejected push re-fetches and retries',
          '- Conflicts never lose data: the other side is saved as a `*.conflict-<device>-<timestamp>` copy, and nothing is committed or pushed until you resolve it',
          '- Ships a `.gitignore` that keeps plugin tokens and multi-megabyte plugin bundles out of your repository',
          '- Credentials stay out of `.git/config`, out of the process arguments, and out of the logs',
          '',
          '### Requirements',
          '',
          '- Obsidian 1.11.4 or later, **desktop only**',
          '- Git 2.28 or later',
          '',
          'See the [README](https://github.com/' + repo + '#readme) for setup and usage.',
        ].join('\n'),
      },
    });
    console.log(`已创建 Release ${tag}`);
  } else {
    console.log(`Release ${tag} 已存在，改为更新附件`);
  }

  // 已存在的同名附件必须先删除，否则上传会冲突
  const existingAssets = await api('GET', `/repos/${repo}/releases/${release.id}/assets`, token);
  for (const asset of existingAssets) {
    await api('DELETE', `/repos/${repo}/releases/assets/${asset.id}`, token);
    console.log(`  已删除旧附件 ${asset.name}`);
  }

  const assets = ['main.js', 'manifest.json', 'styles.css'];
  const uploaded = [];
  for (const assetName of assets) {
    const filePath = path.join(dir, assetName);
    try {
      await fs.access(filePath);
    } catch {
      if (assetName === 'styles.css') {
        console.log(`  跳过 ${assetName}（不存在）`);
        continue;
      }
      throw new Error(`必需附件缺失: ${assetName}`);
    }
    const result = await uploadAsset(token, repo, release.id, filePath, assetName);
    uploaded.push(result);
    console.log(`  已上传 ${result.name}  (${result.size} 字节)`);
  }

  console.log('');
  console.log('=== 完成 ===');
  console.log(`仓库:     ${info.html_url}`);
  console.log(`可见性:   ${info.private ? 'private' : 'PUBLIC ✅'}`);
  console.log(`Release:  ${release.html_url}`);
  console.log(`Tag:      ${tag}  (manifest version = ${version} -> ${tag === version ? '一致 ✅' : '不一致 ❌'})`);
  console.log(`提交:     ${head.slice(0, 7)}`);
  for (const asset of uploaded) {
    console.log(`附件:     ${asset.name} -> ${asset.url}`);
  }
}

main().catch((error) => {
  console.error(`错误: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
