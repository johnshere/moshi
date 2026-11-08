/**
 * 更新包下载（V-03B）：把 release 资产落到 `<data_dir>/updates/`。
 *
 * 只接受 `UpdateStatus` 里已经校验过的 https 资产地址；文件名固定由版本派生，
 * 调用方不能传任意路径——安装步骤只认这个目录里的固定文件。
 */
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dataPaths, type Config } from '../config.js';
import { safeCreateWriteStream } from '../../infra/fs/safeWrite.js';
import { MoshiError } from '../../domain/errors.js';
import { updateAssetName } from '../../domain/update.js';
import type { UpdateStatus } from './check.js';

export interface DownloadedInstaller {
  path: string;
  bytes: number;
}

export function updatesDir(cfg: Config): string {
  return path.join(dataPaths(cfg).root, 'updates');
}

export function installerPath(cfg: Config, version: string): string {
  return path.join(updatesDir(cfg), updateAssetName(version));
}

export async function downloadInstaller(
  cfg: Config,
  status: UpdateStatus,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadedInstaller> {
  if (!status.available || status.latest === null || status.asset_url === null) {
    throw new MoshiError('E_UPDATE', '当前没有可下载的新版本', { latest: status.latest });
  }
  const res = await fetchImpl(status.asset_url, {
    headers: { 'user-agent': `moshi/${status.current}` },
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    throw new MoshiError('E_UPDATE', `下载更新包失败：HTTP ${String(res.status)}`, {
      url: status.asset_url,
    });
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (status.asset_size !== null && bytes.byteLength !== status.asset_size) {
    throw new MoshiError('E_UPDATE', '更新包大小与 release 记录不一致', {
      expected: status.asset_size,
      actual: bytes.byteLength,
    });
  }
  const dest = installerPath(cfg, status.latest);
  const stream = safeCreateWriteStream(dest, [dataPaths(cfg).root], 'w');
  await pipeline(Readable.from([bytes]), stream);
  return { path: dest, bytes: bytes.byteLength };
}
