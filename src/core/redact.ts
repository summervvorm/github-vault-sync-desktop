/**
 * 日志脱敏。
 *
 * 所有离开进程边界的文本（日志、通知、错误消息）都必须先过这里。
 * 两道防线：
 *  ① 精确替换：把当前实际使用的 Token 原样抹掉
 *  ② 模式替换：即使 Token 来自别处（比如从 .git/config 里读到的旧值），
 *     也能按 GitHub Token 的形态特征识别并抹掉
 */

const PATTERN_RULES: Array<[RegExp, string]> = [
  // fine-grained PAT
  [/github_pat_[A-Za-z0-9_]{20,}/g, '***'],
  // classic PAT: ghp_ / gho_ / ghu_ / ghs_ / ghr_
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, '***'],
  // URL 内嵌凭据 https://user:pass@host
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***:***@'],
];

export class Redactor {
  private secrets = new Set<string>();

  add(secret: string | null | undefined): void {
    if (secret && secret.length >= 8) {
      this.secrets.add(secret);
    }
  }

  forget(secret: string | null | undefined): void {
    if (secret) {
      this.secrets.delete(secret);
    }
  }

  clear(): void {
    this.secrets.clear();
  }

  redact(input: string): string {
    if (!input) {
      return input;
    }
    let out = input;
    for (const secret of this.secrets) {
      out = out.split(secret).join('***');
    }
    for (const [pattern, replacement] of PATTERN_RULES) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }
}
