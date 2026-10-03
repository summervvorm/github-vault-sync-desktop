/**
 * 插件级端到端测试。
 *
 * 与 test/headless.ts 的区别：那个测的是 core 层；这个测的是**插件本身** ——
 * 真实调用 onload() / runSync() / onunload()，走完整的 Obsidian 插件生命周期，
 * 并把改动推送到一个真实的裸仓库。
 *
 * 这是"插件在 Obsidian 里能否正常工作"最接近的证据：
 * 除了 Obsidian 的 UI 渲染本身，其余路径全部真实执行。
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

// 直接相对导入桩模块：esbuild 会把 main.ts 里的 'obsidian' 也别名到同一个文件，
// 因此运行时是同一个模块实例（instanceof FileSystemAdapter 才成立）。
// 这样写同时让 tsc 能解析到 registry 等测试钩子。
import { FileSystemAdapter, registry, resetRegistry } from './stubs/obsidian-functional';

import GvsPlugin from '../src/main';

const execFileAsync = promisify(execFile);

const results: Array<{ name: string; ok: boolean }> = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

interface FakeApp {
  vault: {
    configDir: string;
    adapter: FileSystemAdapter;
    on(event: string, handler: unknown): { event: string; handler: unknown };
    offref(): void;
  };
  workspace: { onLayoutReady(cb: () => void): void };
  secretStorage?: { getSecret(id: string): string | null; setSecret(id: string, secret: string): void };
}

/** 桩 Plugin 额外暴露的测试钩子 */
type TestablePlugin = GvsPlugin & {
  __setStoredData(data: unknown): void;
  __getStoredData(): unknown;
};

function makePlugin(app: FakeApp): TestablePlugin {
  return new GvsPlugin(
    app as never,
    { id: 'github-vault-sync', version: '0.1.0' } as never
  ) as unknown as TestablePlugin;
}

function makeApp(vaultDir: string, withSecretStorage: boolean): { app: FakeApp; layoutReady: Array<() => void>; secrets: Map<string, string> } {
  const adapter = new FileSystemAdapter();
  adapter.setBasePath(vaultDir);
  const layoutReady: Array<() => void> = [];
  const secrets = new Map<string, string>();

  const app: FakeApp = {
    vault: {
      configDir: '.obsidian',
      adapter,
      on: (event: string, handler: unknown) => ({ event, handler }),
      offref: () => {},
    },
    workspace: {
      onLayoutReady: (cb: () => void) => {
        layoutReady.push(cb);
      },
    },
  };

  if (withSecretStorage) {
    // 必须与真实 Obsidian 的 API 同名：getSecret / setSecret。
    // 桩如果用了别的方法名，就永远发现不了插件调用错方法名这类 bug。
    app.secretStorage = {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, secret: string) => {
        secrets.set(id, secret);
      },
    };
  }

  return { app, layoutReady, secrets };
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; code: number; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
    return { stdout, code: 0, stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

async function main(): Promise<void> {
  // 插件运行在 Electron 渲染进程里，window 一定存在；Node 下需要补上
  (globalThis as unknown as { window: unknown }).window = {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: unknown) => clearInterval(id as NodeJS.Timeout),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as NodeJS.Timeout),
  };

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gvs-plugin-'));
  const vaultDir = path.join(root, 'vault');
  const remoteDir = path.join(root, 'remote.git');

  try {
    await fs.mkdir(path.join(vaultDir, '文档'), { recursive: true });
    await fs.writeFile(path.join(vaultDir, '文档', '笔记.md'), '# 插件级测试\n\n内容\n', 'utf8');
    await fs.mkdir(path.join(vaultDir, '.obsidian', 'plugins', 'some-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(vaultDir, '.obsidian', 'plugins', 'some-plugin', 'data.json'),
      JSON.stringify({ apiKey: 'SECRET-SHOULD-NOT-BE-COMMITTED' }),
      'utf8'
    );
    await git(['init', '--bare', '-b', 'main', remoteDir], root);

    // ───────────── ① 插件加载 ─────────────
    section('① 插件加载（onload）');

    resetRegistry();
    const { app, layoutReady } = makeApp(vaultDir, false);
    const plugin = makePlugin(app);
    plugin.__setStoredData({
      remoteUrl: remoteDir,
      branch: 'main',
      deviceName: 'plugin-e2e',
      authMode: 'credential-helper',
      autoSyncEnabled: false,
      autoSyncIntervalSec: 300,
      commitMessageTemplate: 'vault sync: {{date}} @{{device}}',
      autoResolveConfigFiles: true,
      keepConflictCopies: true,
      gitPath: '',
    });

    let onloadError: unknown = null;
    try {
      await plugin.onload();
    } catch (error) {
      onloadError = error;
    }
    check('onload 未抛异常', onloadError === null, onloadError instanceof Error ? onloadError.message : '');

    check('注册了 3 个命令', registry.commands.length === 3, registry.commands.map((c) => c.id).join(', '));
    check(
      '命令 id 正确',
      ['sync-now', 'show-log', 'init-repo'].every((id) => registry.commands.some((c) => c.id === id))
    );
    check('注册了设置页', registry.settingTabs.length === 1);
    check('创建了状态栏项', registry.statusBarItems.length === 1);
    check('读取了远端地址设置', plugin.settings.remoteUrl === remoteDir);
    check('未触发 onLayoutReady 前不注册文件事件', registry.events.length === 0);

    // ───────────── ② 布局就绪 ─────────────
    section('② 布局就绪（onLayoutReady）');

    check('onLayoutReady 回调已注册', layoutReady.length === 1);
    for (const cb of layoutReady) {
      cb();
    }
    check('注册了 4 类文件事件', registry.events.length === 4, `实际 ${registry.events.length}`);

    // ───────────── ③ 插件级同步 ─────────────
    section('③ 插件级同步（runSync → 提交 + 推送）');

    // 注意：这里不能 resetRegistry()，否则会丢掉 onload 期间创建的状态栏
    // 与设置页引用，后面的断言就查不到了。
    const outcome = await plugin.runSync('manual');
    check('runSync 返回结果', outcome !== null);
    check('同步状态为 ok', outcome?.status === 'ok', `status=${outcome?.status} msg=${outcome?.message}`);
    check('已提交本地改动', outcome?.committed === true);
    check('已推送到远端', outcome?.pushed === true);

    const remoteHead = await git([`--git-dir=${remoteDir}`, 'rev-parse', 'main'], root);
    check('远端已收到提交', remoteHead.code === 0 && remoteHead.stdout.trim().length > 0, remoteHead.stdout.trim().slice(0, 8));

    const tree = await git(
      [`--git-dir=${remoteDir}`, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'main'],
      root
    );
    check('笔记已推送', tree.stdout.includes('笔记.md'));
    check('插件 data.json 未被推送', !tree.stdout.includes('plugins/'));

    check('状态栏显示已同步', registry.statusBarItems.some((el) => el.textContent.includes('已同步')),
      registry.statusBarItems.map((el) => el.textContent).join(' | '));
    check('弹出了完成通知', registry.notices.some((n) => n.includes('同步完成')), registry.notices.join(' | '));

    // ───────────── ④ 幂等 ─────────────
    section('④ 幂等');

    const again = await plugin.runSync('manual');
    check('再次同步为空转', again?.status === 'up-to-date', `status=${again?.status}`);

    // ───────────── ⑤ 设置页渲染 ─────────────
    section('⑤ 设置页');

    const tab = registry.settingTabs[0] as { display(): void; containerEl: { children: unknown[] } };
    let displayError: unknown = null;
    try {
      tab.display();
    } catch (error) {
      displayError = error;
    }
    check('设置页 display() 未抛异常', displayError === null, displayError instanceof Error ? displayError.message : '');
    check(
      '设置页渲染出内容',
      tab.containerEl.children.length >= 10,
      `${tab.containerEl.children.length} 行设置`
    );

    // ───────────── ⑥ 令牌迁移 ─────────────
    section('⑥ 令牌存储');

    resetRegistry();
    const withSecrets = makeApp(vaultDir, true);
    const plugin2 = makePlugin(withSecrets.app);
    plugin2.__setStoredData({
      remoteUrl: remoteDir,
      branch: 'main',
      deviceName: 'plugin-e2e',
      authMode: 'pat',
      token: 'ghp_PLAINTEXT_TOKEN_IN_DATA_JSON_000000',
      autoSyncEnabled: false,
      gitPath: '',
    });
    await plugin2.onload();

    check('令牌已迁移到 secretStorage', withSecrets.secrets.get('github-vault-sync-token') === 'ghp_PLAINTEXT_TOKEN_IN_DATA_JSON_000000');
    const saved = plugin2.__getStoredData() as Record<string, unknown>;
    check('data.json 中已不含令牌', saved.token === undefined, `token=${String(saved.token)}`);
    check('插件能读到迁移后的令牌', plugin2.getToken() === 'ghp_PLAINTEXT_TOKEN_IN_DATA_JSON_000000');

    resetRegistry();
    const withoutSecrets = makeApp(vaultDir, false);
    const plugin3 = makePlugin(withoutSecrets.app);
    plugin3.__setStoredData({
      remoteUrl: remoteDir,
      branch: 'main',
      authMode: 'pat',
      token: 'ghp_NO_SECRET_STORAGE_TOKEN_000000000',
      autoSyncEnabled: false,
    });
    await plugin3.onload();
    check('无 secretStorage 时令牌不被丢弃', plugin3.getToken() === 'ghp_NO_SECRET_STORAGE_TOKEN_000000000');

    // ───────────── ⑦ 卸载 ─────────────
    section('⑦ 卸载');

    let unloadError: unknown = null;
    try {
      plugin.onunload();
      plugin2.onunload();
      plugin3.onunload();
    } catch (error) {
      unloadError = error;
    }
    check('onunload 未抛异常', unloadError === null, unloadError instanceof Error ? unloadError.message : '');
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
