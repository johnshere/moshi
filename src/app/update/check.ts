/**
 * 更新检查（V-03B）：读 GitHub Releases 的 latest，判断有没有比当前版本新的安装包。
 *
 * 只负责"查"：下载与安装分别是 `download.ts` / `install.ts`。联网通过注入的
 * `fetch`，单测不碰网络；错误一律折成 `ok:false`，设置页只显示一句话，不弹窗。
 */
import {
  isNewer,
  parseVersion,
  pickUpdateAsset,
  updateAssetName,
  type ReleaseAsset,
} from '../../domain/update.js';
import type { Config } from '../config.js';

export interface UpdateStatus {
  schema: 'moshi-update/1';
  enabled: boolean;
  ok: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  /** 发布说明（截断到 4000 字符，避免把整篇 changelog 塞进 UI） */
  notes: string | null;
  page_url: string | null;
  asset_url: string | null;
  asset_name: string | null;
  asset_size: number | null;
  published_at: string | null;
  checked_at: string;
  error: string | null;
}

interface ReleaseJson {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

const ALLOWED_HOSTS = ['github.com', 'api.github.com', 'objects.githubusercontent.com'];

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (!ALLOWED_HOSTS.includes(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseAssets(raw: unknown): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseAsset[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o['name'] === 'string' ? o['name'] : null;
    const url = httpsUrl(o['browser_download_url']);
    if (name === null || url === null) continue;
    out.push({ name, url, ...(typeof o['size'] === 'number' ? { size: o['size'] } : {}) });
  }
  return out;
}

export function feedUrlOf(cfg: Config): string {
  if (cfg.update.feed_url !== '') return cfg.update.feed_url;
  return `https://api.github.com/repos/${cfg.update.repo}/releases/latest`;
}

export function emptyStatus(current: string, checkedAt: string, error: string | null): UpdateStatus {
  return {
    schema: 'moshi-update/1',
    enabled: true,
    ok: false,
    current,
    latest: null,
    available: false,
    notes: null,
    page_url: null,
    asset_url: null,
    asset_name: null,
    asset_size: null,
    published_at: null,
    checked_at: checkedAt,
    error,
  };
}

/** 把 release JSON 折成状态；纯函数，便于单测边界 */
export function statusFromRelease(
  release: unknown,
  current: string,
  checkedAt: string,
): UpdateStatus {
  if (typeof release !== 'object' || release === null) {
    throw new Error('release 不是对象');
  }
  const r = release as ReleaseJson;
  if (typeof r.tag_name !== 'string' || parseVersion(r.tag_name) === null) {
    throw new Error('release 缺少可解析的 tag_name');
  }
  const latest = r.tag_name.replace(/^v/, '');
  // 版本号直接参与文件名与 shell 命令；只放行 semver 字符，挡住 `&` / 引号之类的注入面
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?$/.test(latest)) {
    throw new Error('release tag_name 含非法字符');
  }
  const assets = parseAssets(r.assets);
  const asset = pickUpdateAsset(assets, latest);
  const body = typeof r.body === 'string' ? r.body : '';
  return {
    schema: 'moshi-update/1',
    enabled: true,
    ok: true,
    current,
    latest,
    available: isNewer(latest, current),
    notes: body === '' ? null : body.slice(0, 4000),
    page_url: httpsUrl(r.html_url),
    asset_url: asset?.url ?? null,
    asset_name: asset?.name ?? updateAssetName(latest),
    asset_size: asset?.size ?? null,
    published_at: typeof r.published_at === 'string' ? r.published_at : null,
    checked_at: checkedAt,
    error: null,
  };
}

/** 检查一次（不缓存；调用方要节流就自己记住结果） */
export async function checkForUpdate(
  cfg: Config,
  current: string,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<UpdateStatus> {
  const checkedAt = now().toISOString();
  try {
    const res = await fetchImpl(feedUrlOf(cfg), {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `moshi/${current}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return emptyStatus(current, checkedAt, `GitHub HTTP ${String(res.status)}`);
    }
    return statusFromRelease(await res.json(), current, checkedAt);
  } catch (err) {
    return emptyStatus(current, checkedAt, err instanceof Error ? err.message : String(err));
  }
}
