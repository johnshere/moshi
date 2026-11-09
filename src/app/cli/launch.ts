/**
 * `magpie.cmd` 拉起 moshi 时用的参数解析（Z-01C / 设计 §9.1）。
 *
 * 为什么解析逻辑放在 TS 而不是 bat 里：`.cmd` 里做字符串处理又丑又不可测。
 * 这里只做**纯函数**（不发请求、不起进程），由 CLI 的 `moshi hook launch` 调用，
 * 测试直接引它。
 *
 * 命令形态（由 `packaging/windows/magpie.cmd` 与 Magpie 的插件配置决定）：
 *
 * ```
 * moshi hook launch [--from=magpie] [--cwd=<path>] [--open]
 * ```
 *
 * - `--from=magpie`：本次是"从 Magpie 启动"。F8 里这一条是唯一会自动置连接态的场景。
 * - `--cwd=<path>`：宿主的工程目录，用来在打开界面前建立工程身份。
 *   缺省时**不猜**——不用 `process.cwd()`，因为那可能是 moshi 自己的安装目录。
 * - `--open`：拉起浏览器打开 `/ui/hook?from=magpie`。
 */
export interface LaunchOptions {
  fromMagpie: boolean;
  cwd: string | null;
  open: boolean;
}

export const LAUNCH_USAGE = [
  '用法：moshi hook launch [--from=magpie] [--cwd=<dir>] [--open]',
  '',
  '  --from=magpie  由 Magpie 插件拉起（会自动置连接态）',
  '  --cwd=<dir>    当前工程目录（用来建立工程身份；缺省则不建立）',
  '  --open         打开浏览器到 /ui/hook?from=magpie',
].join('\n');

/** 解析失败返回 null（调用方打用法并退 2），**不抛错** */
export function parseLaunchArgs(argv: readonly string[]): LaunchOptions | null {
  let fromMagpie = false;
  let open = false;
  let cwd: string | null = null;
  for (const raw of argv) {
    const arg = raw.trim();
    if (arg === '') continue;
    if (arg === '--from=magpie') {
      fromMagpie = true;
      continue;
    }
    if (arg === '--open') {
      open = true;
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      const v = arg.slice('--cwd='.length).trim();
      if (v === '') return null;
      cwd = v;
      continue;
    }
    return null;
  }
  return { fromMagpie, cwd, open };
}

/** 界面 URL（`?from=magpie` 让页面知道要不要自动建立身份） */
export function hookPageUrl(base: string, fromMagpie: boolean): string {
  const b = base.replace(/\/+$/, '');
  return fromMagpie ? `${b}/ui/hook?from=magpie` : `${b}/ui/hook`;
}

/** 从 lock 文件内容里还原 daemon 的 base URL（`http://host:port`） */
export function daemonBaseUrl(host: string, port: number): string {
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${h}:${port}`;
}
