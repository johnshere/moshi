/**
 * 版本比较与更新包选择（V-03B）。
 *
 * 纯函数，不联网、不读配置：更新检查的判定（有没有新版、装哪个资产）必须能
 * 在单测里穷举边界，而"从哪拿 manifest"属于 app 层。
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** 接受 `1.2.3` / `v1.2.3`；预发布后缀（`-beta.1`）按主版本比较，不参与排序 */
export function parseVersion(input: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(input.trim());
  if (m === null) return null;
  const [, a, b, c] = m;
  if (a === undefined || b === undefined || c === undefined) return null;
  return { major: Number(a), minor: Number(b), patch: Number(c) };
}

/** a < b → 负数；相等 → 0；a > b → 正数。无法解析的版本视为最小 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** 安装包资产命名：`moshi-setup-<version>.exe`（构建脚本与更新检查共用） */
export function updateAssetName(version: string): string {
  return `moshi-setup-${version}.exe`;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size?: number;
}

/** 只认精确命名的安装包；没有就返回 null（不拿 source.zip 之类的资产凑数） */
export function pickUpdateAsset(
  assets: readonly ReleaseAsset[],
  version: string,
): ReleaseAsset | null {
  const wanted = updateAssetName(version);
  return assets.find((a) => a.name === wanted) ?? null;
}
