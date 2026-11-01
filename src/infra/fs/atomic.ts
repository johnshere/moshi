/**
 * 原子写文件（tmp + rename）。
 *
 * 为什么所有落盘都要走这里：`cursors.json` 写一半被打断 → 下次启动解析失败 →
 * 游标全丢 → 重复 harvest 整个历史（幂等键能挡住重复行，但白跑几十分钟）。
 * `rename` 在同一文件系统内是原子的，所以"要么旧内容、要么新内容"，没有中间态。
 *
 * Windows 的坑：`rename` 覆盖已存在文件在 Windows 上会失败（EPERM/EEXIST），
 * 必须先 `unlink`。这里做了兼容，代价是极短时间内文件不存在——
 * 对"读不到就当没有"的调用方（游标、锁）是可接受的。
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function writeFileAtomic(file: string, data: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${String(process.pid)}.tmp`);
  writeFileSync(tmp, data, 'utf8');
  try {
    renameSync(tmp, file);
  } catch {
    // Windows: 目标存在时 rename 会失败
    try {
      unlinkSync(file);
    } catch {
      // 目标本来就不存在，忽略
    }
    renameSync(tmp, file);
  }
}
