/**
 * 项目的**文件系统**识别（Z-01C / 设计 §5.4，用户 11-08 定案，决策 D-175）。
 *
 * 放在 `app` 而不是 `domain`：它要读目录、读 `.git/config`、可能要**新建**标志文件，
 * 是副作用，不是纯函数。`domain/identity.ts` 只管"输入 → 哈希"，不知道文件系统存在。
 *
 * 识别顺序（一旦命中即停止，不猜、不合并）：
 *
 * ```
 * 1) 从 cwd 向上找版本控制标志 .git / .svn / .hg
 *      .git 且 origin 有值     → kind=vcs，root=仓库根，remote=规范化 URL
 *      .git 但无 origin        → kind=vcs，root=仓库根，remote=null
 *      .svn / .hg              → kind=vcs，root=标志所在目录，remote=null
 * 2) 再向上找就近的自建标志 .moshi/project.yaml → kind=local
 * 3) 都没有 → 在 cwd 新建 .moshi/project.yaml → kind=local
 * ```
 *
 * 用户明确放弃的东西（别再捡回来）：`.ai-memory.toml` / `.serena/project.yml` /
 * mem0 project id 等第三方标志；手动指定工程。
 *
 * **排除规则**：往上走时跳过**名字就叫 `.moshi`** 的目录——那多半是本系统自己的标志目录，
 * 拿它当项目根会让 `project_id` 落在标志目录上而不是真正的工程上。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { projectIdOf, type IdentitySource, type ProjectIdentityInput } from '../../domain/identity.js';
import { safeEnsureDir, safeWriteFile } from '../../infra/fs/safeWrite.js';

/** 自建标志文件（用户裁决：用 yaml） */
export const MARKER_DIR = '.moshi';
export const MARKER_FILE = 'project.yaml';
export const MARKER_SCHEMA = 'moshi-project/1';

/** 识别结果：命中哪一档、根目录在哪、哈希 id 是多少 */
export interface ProjectIdentity {
  readonly source: IdentitySource;
  /** 项目根（绝对路径，已规范化分隔符）；unknown 时为 null */
  readonly root: string | null;
  readonly projectId: string | null;
  /** vcs 档才有；无 remote 或 svn/hg 时为 null */
  readonly remote: string | null;
  /** 读/写明文说明，给 `moshi hook doctor` 与界面显示"为什么是这一档" */
  readonly reason: string;
}

export const UNKNOWN_PROJECT: ProjectIdentity = {
  source: 'unknown',
  root: null,
  projectId: null,
  remote: null,
  reason: '没有 cwd',
};

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 是否存在（**必须用返回值**：`existsSync` 只返回布尔值，不匹配会抛错） */
function exists(p: string): boolean {
  return existsSync(p);
}

/** 路径统一成 `/` 分隔、去尾斜杠（与 `domain/scope.ts` 的 `normalizeCwd` 同口径） */
export function normalizeRoot(p: string): string {
  const abs = path.resolve(p).replace(/\\/g, '/');
  if (/^[A-Za-z]:\/$/.test(abs) || abs === '/') return abs;
  return abs.replace(/\/+$/, '');
}

/**
 * remote 规范化：`git@github.com:John/Moshi.git`、`https://github.com/john/moshi.git/`
 * 都归成 `github.com/john/moshi`。归一不了的（本地路径 remote）原样返回。
 */
export function normalizeRemote(raw: string): string | null {
  const s = raw.trim();
  if (s === '') return null;
  // scp 风格：user@host:path
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(s);
  // 单字母"host"是盘符（`J:\Repo\Demo`），那是本地路径不是 scp，交给下面的兜底
  if (scp !== null && !s.includes('://') && !(scp[1]!.length === 1 && /[A-Za-z]/.test(scp[1]!))) {
    return finishRemote(`${scp[1]}/${scp[2]}`);
  }
  try {
    const url = new URL(s);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ssh:' || url.protocol === 'git:') {
      return finishRemote(`${url.hostname}/${url.pathname}`);
    }
  } catch {
    // 落到下面的兜底
  }
  // file:// 与本地路径：保留规范化后的路径本身（同一目录仍然稳定）
  const local = s.replace(/^file:\/\//, '');
  return local === '' ? null : finishRemote(local) || null;
}

function finishRemote(s: string): string {
  const normalized = s.replace(/\\/g, '/');
  // 盘符前的斜杠（`J:/repo`）是根，不是分隔符重复；后续的重复斜杠才要压
  const guarded = /^[a-z]:\//i.test(normalized)
    ? `${normalized.slice(0, 2)}${normalized.slice(2).replace(/\/{2,}/g, '/')}`
    : normalized.replace(/\/{2,}/g, '/');
  return guarded.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

/**
 * 从 `.git/config` 直接读 origin url。
 *
 * 为什么不起 `git` 子进程：钩子有 1000ms 预算，`git config` 在 Windows 上
 * 动辄 50–150ms，而且"没装 git"本身就是一个要处理的降级分支——读文件两种情形都更简单。
 * 认不出来就返回 null（→ remote=null，靠 root 区分），**不猜**。
 */
export function readOriginUrl(gitDir: string): string | null {
  let text: string;
  try {
    text = readFileSync(path.join(gitDir, 'config'), 'utf8');
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[(.+?)\]\s*$/.exec(line);
    if (header !== null) {
      inOrigin = /^remote\s+"origin"$/.test(header[1]!.trim());
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^\s*url\s*=\s*(.+)$/.exec(line);
    if (kv !== null) return kv[1]!.trim();
  }
  return null;
}

/** `.git` 可能是目录，也可能是 worktree / submodule 的 gitfile（`gitdir: ...`） */
function realGitDir(gitPath: string): string | null {
  if (isDir(gitPath)) return gitPath;
  try {
    const text = readFileSync(gitPath, 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (m === null) return null;
    const dir = path.resolve(path.dirname(gitPath), m[1]!.trim());
    return isDir(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * 从 start 一路向上收集候选目录。
 *
 * 起点自己就叫 `.moshi` 时**整条链都不算**：`.moshi` 是我们自己的标志目录/数据目录，
 * 把它当工程根会让"工程"变成"我们自己的元数据"，而且它的上一步已被算过一遍。
 * （用户要求：名字叫 `.moshi` 的同名文件夹要排除。）
 */
function ancestors(start: string): string[] {
  const out: string[] = [];
  let cur = normalizeRoot(start);
  if (path.posix.basename(cur) === MARKER_DIR) return out;
  for (;;) {
    out.push(cur);
    const parent = path.posix.dirname(cur);
    if (parent === cur || parent === '' || parent === '.') break;
    cur = parent;
  }
  return out;
}

function fromVcs(root: string): ProjectIdentity {
  const gitPath = path.join(root, '.git');
  let remote: string | null = null;
  let reason = '命中 .git';
  const gitDir = realGitDir(gitPath);
  if (gitDir !== null) {
    const origin = readOriginUrl(gitDir);
    remote = origin === null ? null : normalizeRemote(origin);
    reason = origin === null ? '命中 .git（无 origin，靠 root 区分）' : '命中 .git + origin';
  }
  return buildIdentity({ kind: 'vcs', root, remote }, 'vcs', reason);
}

function fromLocal(root: string, reason: string): ProjectIdentity {
  return buildIdentity({ kind: 'local', root }, 'local', reason);
}

function buildIdentity(
  input: ProjectIdentityInput,
  source: IdentitySource,
  reason: string,
): ProjectIdentity {
  return {
    source,
    root: input.root,
    projectId: projectIdOf(input),
    remote: input.kind === 'vcs' ? input.remote : null,
    reason,
  };
}

/**
 * 主入口。`create`：找不到标志时是否**新建** `.moshi/project.yaml`（写盘）。
 *
 * `create=false` 用于"只看不写"的场景（`moshi hook doctor`、界面里的只读展示）：
 * 这时候必须如实返回 unknown，而不是顺手在别人的仓库里落下文件。
 *
 * 两种 `create` 分叉：
 * - `create='establish'`（`magpie.cmd` 拉起软件时用一次）：路径身份**也算**命中。
 *   否则同一个目录会在"插件第一次触发时落标志"与"这里先算出来"之间来回翻——先打开
 *   界面的场景下，工程会被错标成 unknown，直到某个钩子先把它建出来为止。
 * - `create=true`（钩子侧）：路径身份不算命中，等用户真的在该目录里开始干活才落标志。
 */
export function resolveProjectIdentity(
  cwd: string | null | undefined,
  options: { create?: boolean | 'establish'; roots?: readonly string[] } = {},
): ProjectIdentity {
  const mode = options.create ?? false;
  if (cwd === null || cwd === undefined || cwd.trim() === '') return UNKNOWN_PROJECT;
  let start: string;
  try {
    start = normalizeRoot(cwd);
  } catch {
    return { ...UNKNOWN_PROJECT, reason: `cwd 非法：${cwd}` };
  }
  if (!exists(start)) {
    // cwd 不存在：不能向上走（父目录集是另一码事），如实 unknown
    return { ...UNKNOWN_PROJECT, reason: `cwd 不存在：${start}` };
  }

  const dirs = ancestors(start);

  // 1) 版本控制标志
  for (const dir of dirs) {
    if (exists(path.join(dir, '.git'))) return fromVcs(dir);
    if (exists(path.join(dir, '.svn'))) return fromLocal(dir, '命中 .svn');
    if (exists(path.join(dir, '.hg'))) return fromLocal(dir, '命中 .hg');
  }

  // 2) 就近的自建标志
  for (const dir of dirs) {
    if (exists(path.join(dir, MARKER_DIR, MARKER_FILE))) return fromLocal(dir, '命中 .moshi/project.yaml');
  }

  // 3) 自建
  if (mode === false) {
    return { ...UNKNOWN_PROJECT, reason: '没有版本控制标志，也没有 .moshi/project.yaml（未新建）' };
  }
  const target = start;
  // 名字就叫 `.moshi` 的目录不当工程根（与 `ancestors` 同一条规矩）：退回它的父目录
  const base = path.posix.basename(target) === MARKER_DIR ? normalizeRoot(path.posix.dirname(target)) : target;
  const identity = fromLocal(
    base,
    base === target ? '在 cwd 自建 .moshi/project.yaml' : 'cwd 本身是 .moshi 目录，改为在其父目录自建',
  );
  // 注意白名单必须由调用方显式给出：`writeMarker` 的默认值是 `[root]`，
  // 那等于"往哪儿写都行"，白名单就形同虚设
  if (options.roots === undefined || options.roots.length === 0) {
    return { ...identity, reason: `${identity.reason}（未落盘：没有可写白名单）` };
  }
  writeMarker(base, identity, options.roots);
  return mode === 'establish' ? { ...identity, reason: `${identity.reason}（界面建立）` } : identity;
}

/** 标志文件内容（设计 §5.6）。`project_id` 生成后永不改变，已有文件只读不写。 */
export function renderMarker(identity: ProjectIdentity): string {
  return [
    `schema: ${MARKER_SCHEMA}`,
    `project_id: ${identity.projectId ?? ''}`,
    `kind: ${identity.source === 'vcs' ? 'vcs' : 'local'}`,
    `root: '${(identity.root ?? '').replace(/'/g, "''")}'`,
    `created_at: '${new Date().toISOString()}'`,
    '',
  ].join('\n');
}

/**
 * 写标志文件；已存在则**一个字都不改**（`project_id` 永不覆盖）。
 *
 * 白名单：调用方必须把 `roots` 传进来，且必须包含目标目录——否则 `safeWriteFile` 抛
 * E_ACCESS。这是"moshi 不擅自往宿主任意位置写文件"的执行点。
 */
export function writeMarker(root: string, identity: ProjectIdentity, roots?: readonly string[]): void {
  const dir = path.join(root, MARKER_DIR);
  const file = path.join(dir, MARKER_FILE);
  if (exists(file)) return;
  const allowRoots = roots ?? [root];
  safeEnsureDir(dir, allowRoots);
  safeWriteFile(file, renderMarker(identity), allowRoots);
}

/** 读已有标志文件里的 `project_id`（只用于显示；身份判定不信任它，见下） */
export function readMarkerProjectId(root: string): string | null {
  try {
    const text = readFileSync(path.join(root, MARKER_DIR, MARKER_FILE), 'utf8');
    const m = /^project_id:\s*(\S+)\s*$/m.exec(text);
    return m === null ? null : m[1]!;
  } catch {
    return null;
  }
}

/**
 * 标志文件里的 `project_id` 与"按当前规则算出来的"不一致时**以规则为准**。
 *
 * 理由：`project_id` 的输入只有 root/remote，是纯函数；把文件里的值当权威的话，
 * 有人改了 yaml 就能把两个工程合成一个，而我们要的"生成后永不改变"在纯函数下
 * 本来就已经满足（同一个目录永远算出同一个 id）。标志文件在这里的作用是
 * **"这里是一个工程根"的声明**，不是 id 的权威存储。
 */
export function identityMatchesMarker(root: string, identity: ProjectIdentity): boolean {
  const declared = readMarkerProjectId(root);
  return declared === null || declared === identity.projectId;
}
