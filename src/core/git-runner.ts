import { execFile } from 'node:child_process';
import type { AuthConfig, GitResult, RunOptions } from './types';
import { Redactor } from './redact';

/**
 * git 进程统一封装。
 *
 * 硬性约束（见设计文档 3.2.4）：一律使用异步 execFile。
 * 同类插件最严重的已知缺陷就是定时同步期间 UI 冻结 30–60 秒，
 * 根因是在主线程上做同步阻塞调用。这里不存在任何 *Sync 调用。
 */

/** Token 通过环境变量传给凭据助手，绝不进入命令行参数 */
const TOKEN_ENV_KEY = 'GVS_GIT_TOKEN';

const MAX_BUFFER = 32 * 1024 * 1024;

export interface BufferResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  failed: boolean;
}

export class GitRunner {
  private redactor: Redactor;
  private auth: AuthConfig;

  constructor(
    public readonly gitPath: string,
    public readonly cwd: string,
    options: { redactor?: Redactor; auth?: AuthConfig } = {}
  ) {
    this.redactor = options.redactor ?? new Redactor();
    this.auth = options.auth ?? { mode: 'credential-helper' };
  }

  getRedactor(): Redactor {
    return this.redactor;
  }

  setAuth(auth: AuthConfig): void {
    if (this.auth.mode === 'pat') {
      this.redactor.forget(this.auth.token);
    }
    this.auth = auth;
    if (auth.mode === 'pat') {
      this.redactor.add(auth.token);
    }
  }

  /**
   * 构造真正传给 git 的参数与环境变量。
   *
   * 环境变量净化的理由见设计文档 3.2.2：
   *  - GIT_DIR / GIT_WORK_TREE 会让 git 忽略 cwd，直接操作**另一个仓库**
   *  - GIT_TERMINAL_PROMPT=0 防止 git 弹交互式提示把进程挂死到超时
   *  - GIT_OPTIONAL_LOCKS=0 让只读命令不抢 index.lock
   *  - LC_ALL=C 让输出稳定为英文，便于解析
   */
  buildInvocation(args: string[]): { argv: string[]; env: NodeJS.ProcessEnv } {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_OPTIONAL_LOCKS = '0';
    env.LC_ALL = 'C';

    const argv: string[] = [];

    if (this.auth.mode === 'pat') {
      this.redactor.add(this.auth.token);
      env[TOKEN_ENV_KEY] = this.auth.token;
      // 先用空值清掉可能继承来的凭据助手，再挂上我们的内联助手。
      // 助手以 ! 开头，由 git 通过 shell 执行，因此 Token 只在环境变量里，
      // 不会出现在 argv、.git/config 或 `git remote -v` 的输出中。
      argv.push(
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=!f() { echo username=${this.auth.username}; echo password="$${TOKEN_ENV_KEY}"; }; f`
      );
    }

    argv.push(...args);
    return { argv, env };
  }

  async run(args: string[], options: RunOptions = {}): Promise<GitResult> {
    const { argv, env } = this.buildInvocation(args);

    return new Promise<GitResult>((resolve) => {
      execFile(
        this.gitPath,
        argv,
        {
          cwd: this.cwd,
          env,
          timeout: options.timeoutMs ?? 60000,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          const error = err as (Error & { code?: number | string; killed?: boolean }) | null;
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolve({
            code,
            stdout: this.redactor.redact(String(stdout ?? '')),
            stderr: this.redactor.redact(String(stderr ?? '')),
            failed: code !== 0,
            timedOut: Boolean(error?.killed),
          });
        }
      );
    });
  }

  /** 二进制安全取回（用于 git show :3:path 这类可能返回图片内容的命令） */
  async runBuffer(args: string[], options: RunOptions = {}): Promise<BufferResult> {
    const { argv, env } = this.buildInvocation(args);

    return new Promise<BufferResult>((resolve) => {
      execFile(
        this.gitPath,
        argv,
        {
          cwd: this.cwd,
          env,
          timeout: options.timeoutMs ?? 60000,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          encoding: 'buffer',
        },
        (err, stdout, stderr) => {
          const error = err as (Error & { code?: number | string }) | null;
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolve({
            code,
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
            stderr: this.redactor.redact(String(stderr ?? '')),
            failed: code !== 0,
          });
        }
      );
    });
  }

  /** 把多行输出切成去掉空行的数组 */
  async lines(args: string[], options: RunOptions = {}): Promise<string[]> {
    const result = await this.run(args, options);
    if (result.failed) {
      return [];
    }
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}
