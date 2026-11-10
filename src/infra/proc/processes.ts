/**
 * 进程名枚举（Z-01C-h / 设计 §16.3）。
 *
 * 只做一件事：拿到本机正在跑的进程名列表，给"宿主是否在运行"当一路证据。
 * 两条命令线：Windows `tasklist /FO CSV /NH`、其它平台 `ps -eo comm=`。
 *
 * **任何失败都返回空数组**：探测是机会性的，拿不到进程只意味着"少一路证据"，
 * 不能把首启引导弄挂。也不引 `ps-list` 之类依赖（概设 §8.9：不加没必要的依赖）。
 */
import { execFile } from 'node:child_process';

/** 单次枚举超时：探测总预算 1200ms，进程这一路最多占 800ms */
const TIMEOUT_MS = 800;

/** Windows：`tasklist` 的 CSV 第一列是映像名 */
function parseWindows(stdout: string): readonly string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // CSV 形如 `"magpie-windows-amd64.exe","1234","Console","1","12,345 K"`
    const first = trimmed.startsWith('"') ? trimmed.slice(1, trimmed.indexOf('"', 1)) : trimmed.split(',')[0];
    const name = (first ?? '').trim().toLowerCase();
    if (name !== '') names.push(name);
  }
  return names;
}

/** POSIX：`ps -eo comm=` 每行一个可执行名（可能是全路径，取 basename） */
function parsePosix(stdout: string): readonly string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1).toLowerCase();
    if (base !== '') names.push(base);
  }
  return names;
}

/**
 * 列出本机进程名（小写）。失败 / 超时 → `[]`，调用方按"这一路没命中"处理。
 *
 * `platform` 可注入，测试不必依赖跑测试的机器是 Windows 还是 Linux。
 */
export function listProcessNames(platform: NodeJS.Platform = process.platform): Promise<readonly string[]> {
  const [command, args]: readonly [string, readonly string[]] =
    platform === 'win32' ? ['tasklist', ['/FO', 'CSV', '/NH']] : ['ps', ['-eo', 'comm=']];
  return new Promise((resolve) => {
    let settled = false;
    const done = (names: readonly string[]): void => {
      if (settled) return;
      settled = true;
      resolve(names);
    };
    try {
      execFile(
        command,
        [...args],
        { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) {
            done([]);
            return;
          }
          done(platform === 'win32' ? parseWindows(stdout) : parsePosix(stdout));
        },
      );
    } catch {
      done([]);
    }
  });
}
