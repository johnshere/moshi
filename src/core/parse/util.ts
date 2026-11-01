/**
 * 解析器的小工具。
 *
 * `allMatches` 存在的唯一理由：模块级正则带 `g` 时 `test()` / `exec()` 会推进
 * `lastIndex`，同一个正则第二次调用结果就变了——这类 bug 只在"同一进程里跑第二次"
 * 时出现，单测跑一次永远发现不了。`matchAll` 在内部克隆正则，不碰 `lastIndex`。
 */

export function allMatches(text: string, re: RegExp): RegExpMatchArray[] {
  return [...text.matchAll(re)];
}

export function firstMatch(text: string, re: RegExp): RegExpMatchArray | null {
  for (const m of text.matchAll(re)) return m;
  return null;
}

/** 取第 n 个捕获组，缺失或未参与匹配时返回空串——调用方不必到处写 `?? ''` */
export function group(m: RegExpMatchArray, n: number): string {
  return m[n] ?? '';
}

export function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** 取可执行文件的 basename，去掉 `.exe`：`/usr/bin/Node` → `node` */
export function executableName(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? '';
  const base = first.replace(/^.*[/\\]/, '').replace(/\.exe$/i, '');
  return base.toLowerCase();
}

/** 把相对路径接到 cwd 上（纯词法，不碰文件系统；统一用 `/`） */
export function joinPath(cwd: string | undefined, name: string): string {
  if (cwd === undefined || cwd === '') return name;
  if (/^(?:[A-Za-z]:)?[/\\]/.test(name) || name.startsWith('~')) return name;
  return `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${name}`;
}

/** 项目主体：有 cwd 用 cwd，没有就用 `.`（表示"当前这个未知仓库/目录"） */
export function projectName(turn: { cwd?: string }): string {
  return turn.cwd === undefined || turn.cwd === '' ? '.' : turn.cwd;
}

/** 命令行前 3 个 token，作为 `ext.argv` */
export function argvOf(cmd: string): string[] {
  return cmd.trim().split(/\s+/).slice(0, 3);
}

/** `raw_excerpt`：命中的那一行，截到 200 字符——UI 检查器要能回答"为什么我信这条" */
export function excerpt(line: string, max = 200): string {
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
