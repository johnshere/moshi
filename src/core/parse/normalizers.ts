/**
 * 规范化（详设 §5.4）。
 *
 * 规范化的唯一目的是**让同一个东西只有一个字符串**：`Node.js` / `nodejs` / `node`
 * 必须落到同一个 `pkg:node`，否则身份键不同，幂等失效，同一个事实会反复入库。
 *
 * 两条纪律：
 * 1. **纯词法**，不碰文件系统——未挂载的路径不该让规范化失败；
 * 2. 失败返回 `null` 而不是抛错——走 provisional 路径，事实不丢（详设 §5.4 末段）。
 */

/** v1.1 移到 ontology 表；现在先硬编码，改动必须同步详设 */
const PKG_ALIASES: Readonly<Record<string, string>> = {
  'node.js': 'node',
  nodejs: 'node',
  node: 'node',
  py: 'python',
  python3: 'python',
  python: 'python',
  golang: 'go',
  postgres: 'postgresql',
  'pg': 'postgresql',
  'k8s': 'kubernetes',
};

/** `Node.js` / `nodejs` / `node` → `pkg:node` */
export function normalizePkg(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // 作用域包保持 `@scope/name`，只统一分隔符与大小写
  const unified = trimmed.replace(/\\/g, '/').toLowerCase();
  if (unified.startsWith('@')) return `pkg:${unified}`;

  // 先查原样（`node.js` 在表里），再查去掉 `.js` 后的（`node.js` → `node`）
  const alias = PKG_ALIASES[unified] ?? PKG_ALIASES[unified.replace(/\.js$/, '')] ?? unified;
  return `pkg:${alias}`;
}

/** `"8080"` / `":8080"` → `"port:8080"`；非法返回 null */
export function normalizePort(raw: string | number): string | null {
  const text = String(raw).trim().replace(/^:/, '');
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  if (n < 1 || n > 65535) return null;
  return `port:${n}`;
}

/**
 * `~/a//b/../c/` → `"~/a/c"`
 *
 * `~` 保持为字面前缀而不是展开成真实 home：展开会让同一个观察在换用户名后产生两个 key。
 * `..` 消解是纯词法的，越过 `~` 就停在 `~`。
 */
export function normalizePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  let p = trimmed.replace(/\\/g, '/');
  const isHome = p === '~' || p.startsWith('~/');
  if (p === '~') return '~';

  // win32 只把盘符小写，其余保持原样（Linux 路径区分大小写）
  p = p.replace(/^([A-Za-z]):\//, (_m, d: string) => `${d.toLowerCase()}:/`);

  const absolute = p.startsWith('/');
  const homeRelative = isHome;
  const body = isHome ? p.slice(2) : p.replace(/^\/+/, '');

  const out: string[] = [];
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute && !homeRelative) out.push('..');
      // 绝对路径与 ~ 之上的 .. 直接丢弃（/../a === /a）
      continue;
    }
    out.push(seg);
  }

  const joined = out.join('/');
  if (homeRelative) return joined === '' ? '~' : `~/${joined}`;
  if (absolute) return `/${joined}`;
  return joined === '' ? '.' : joined;
}

/** `v22.9.0` / `22.9` → `"22.9.0"` / `"22.9"`；缺 patch 就只保留两段 */
export function normalizeVersion(raw: string): string | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/i.exec(raw.trim());
  if (m === null) return null;
  const major = m[1] as string;
  const minor = m[2] as string;
  const patch = m[3];
  return patch === undefined ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

/** `/usr/bin/Node` → `"node"`；`C:\Program Files\x\node.EXE` → `"node"` */
export function normalizeProcess(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const unified = trimmed.replace(/\\/g, '/');
  const base = unified.slice(unified.lastIndexOf('/') + 1);
  const noExt = base.replace(/\.exe$/i, '');
  if (noExt === '') return null;
  return process.platform === 'win32' ? noExt.toLowerCase() : noExt;
}

/** `"Installed Version"` → `"installed_version"` */
export function normalizePredicate(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return s === '' ? null : s;
}

export type NormalizerKind = 'pkg' | 'port' | 'path' | 'version' | 'process' | 'predicate';

const NORMALIZERS: Readonly<Record<NormalizerKind, (raw: string) => string | null>> = {
  pkg: normalizePkg,
  port: (raw) => normalizePort(raw),
  path: normalizePath,
  version: normalizeVersion,
  process: normalizeProcess,
  predicate: normalizePredicate,
};

/**
 * 统一入口。`etype` 直接当 kind 用（pkg/port/path/version/process 同名），
 * 其余 etype（service / concept / unknown）不做规范化，返回去空白后的原文。
 */
export function normalizeSubject(raw: string, kind: string): string | null {
  const fn = NORMALIZERS[kind as NormalizerKind];
  if (fn === undefined) {
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }
  return fn(raw);
}

export function isKnownNormalizer(kind: string): kind is NormalizerKind {
  return kind in NORMALIZERS;
}
