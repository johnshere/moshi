/**
 * 迁移执行器（详设 §2.7）。
 *
 * 四条纪律：
 * 1. `user_version` 是唯一真相；迁移文件只增不改；
 * 2. 不允许降级（新库 + 旧 daemon 必炸，旧库 + 新 daemon 才行）；
 * 3. 迁移前 `VACUUM INTO` 备份——SQLite 的事务能回滚 DDL，但回滚不了"我已经把库改坏了"；
 * 4. 每个文件一个事务，跑完校验版本号，不符即抛。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MoshiError } from '../../domain/errors.js';
import { EMBED_DIM } from '../../domain/embedding.js';
import type { Db } from './db.js';

const FILE_RE = /^(\d{3})_.*\.sql$/;

export const TARGET_VERSION = 7;

export interface MigrateOptions {
  migrationsDir?: string;
  backupsDir?: string;
  /** 目标版本，默认取 migrations 目录里最大的编号 */
  target?: number;
  /** sqlite-vec 是否可用（决定 fact_vec 建不建） */
  vectorEnabled?: boolean;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
  backupPath: string | null;
  vectorEnabled: boolean;
}

export function defaultMigrationsDir(): string {
  // src/infra/sqlite → 项目根；dist/infra/sqlite 同样是三层
  return path.resolve(import.meta.dirname, '../../../migrations');
}

export function listMigrations(dir: string): { version: number; file: string }[] {
  if (!existsSync(dir)) {
    throw new MoshiError('E_CONFIG', `迁移目录不存在：${dir}`, { dir });
  }
  const out: { version: number; file: string }[] = [];
  for (const name of readdirSync(dir)) {
    const m = FILE_RE.exec(name);
    if (m === null) continue;
    out.push({ version: Number(m[1]), file: path.join(dir, name) });
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

function userVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** 当前库的 `user_version`（`moshi db migrate` / 诊断展示用；只读） */
export function currentUserVersion(db: Db): number {
  return userVersion(db);
}

/**
 * 把 WAL 截断回主库（`moshi db vacuum` 收尾用）。
 *
 * 放在这里是因为 `moshi db` 的写权限收口在 infra：app 层禁止 `db.pragma`（见
 * `tools/check-lifecycle.ts`），而本文件已是迁移/版本号这件事的 owner。
 */
export function checkpointWal(db: Db): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
}

function hasTables(db: Db): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view')")
    .get() as { n: number };
  return row.n > 0;
}

function backup(db: Db, dir: string, from: number): string {
  mkdirSync(dir, { recursive: true });
  let target = path.join(dir, `pre-migrate-${from}.db`);
  if (existsSync(target)) {
    target = path.join(dir, `pre-migrate-${from}-${Date.now()}.db`);
  }
  // VACUUM INTO 不能在事务里跑；路径里的单引号要转义
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

/** fact_vec 依赖 sqlite-vec，扩展不在时跳过并打标记（详设 §2.2 末段） */
/** 探测 vec0 模块是否已加载（openDb 在连接上装了 sqlite-vec 才为真） */
function hasVec0(db: Db): boolean {
  try {
    return db.prepare("SELECT 1 AS v FROM pragma_module_list WHERE name = 'vec0'").get() !== undefined;
  } catch {
    return false;
  }
}

/** 记录 fact_vec 的维度：vec0 的维度写死在 CREATE 里，换模型必须重建表。 */
const VEC_DIM_KEY = 'vec_dim';

function ensureVectorTable(db: Db, enabled: boolean, dim: number = EMBED_DIM): boolean {
  if (!enabled) {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('vector_disabled','1')").run();
    return false;
  }
  try {
    const exists =
      db
        .prepare("SELECT 1 AS v FROM sqlite_master WHERE type = 'table' AND name = 'fact_vec'")
        .get() !== undefined;
    const recorded = (
      db.prepare('SELECT value FROM meta WHERE key = ?').get(VEC_DIM_KEY) as
        | { value: string }
        | undefined
    )?.value;
    if (exists && recorded !== undefined && Number(recorded) === dim) {
      db.prepare("DELETE FROM meta WHERE key = 'vector_disabled'").run();
      return true;
    }
    // 维度变了（或旧库没记维度）：旧向量与新模型不可比，直接重建表，
    // 行由 syncFactVectors 按新模型重编码，不存在"半新半旧"的混合空间。
    if (exists) db.exec('DROP TABLE fact_vec');
    db.exec(
      `CREATE VIRTUAL TABLE fact_vec USING vec0(
         fact_id  TEXT PRIMARY KEY,
         embedding float[${dim}]
       )`,
    );
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(VEC_DIM_KEY, String(dim));
    db.prepare("DELETE FROM meta WHERE key = 'vector_disabled'").run();
    return true;
  } catch {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('vector_disabled','1')").run();
    return false;
  }
}

export function migrate(db: Db, opts: MigrateOptions = {}): MigrateResult {
  const dir = opts.migrationsDir ?? defaultMigrationsDir();
  const files = listMigrations(dir);
  const maxVersion = files.reduce((acc, f) => Math.max(acc, f.version), 0);
  const target = opts.target ?? maxVersion;
  const from = userVersion(db);

  if (from === target) {
    const vectorEnabled = ensureVectorTable(db, opts.vectorEnabled ?? hasVec0(db));
    return { from, to: target, applied: [], backupPath: null, vectorEnabled };
  }
  if (from > target) {
    throw new MoshiError(
      'E_CONFIG',
      `数据库版本 ${from} 高于本程序支持的 ${target}：不允许降级（概设 §2.3）`,
      { from, target },
    );
  }

  const pending = files.filter((f) => f.version > from && f.version <= target);
  if (pending.length === 0) {
    throw new MoshiError('E_CONFIG', `没有可用的迁移文件（当前 ${from} → 目标 ${target}）`, {
      from,
      target,
      dir,
    });
  }

  const backupPath = hasTables(db) ? backup(db, opts.backupsDir ?? path.join(dir, '..', 'backups'), from) : null;

  const applied: string[] = [];
  for (const item of pending) {
    const sql = readFileSync(item.file, 'utf8');
    // 表重建迁移（如 006 扩 ftype CHECK）必须在事务外关掉外键，否则 DROP 父表
    // 会被 edge/feedback/evidence_log/layout 的引用挡住。标记写在 SQL 第一行，
    // 只有显式声明的迁移才关，其它迁移仍保持 foreign_keys=ON。
    const fkOff = /^\s*--\s*moshi:foreign_keys_off\b/m.test(sql);
    if (fkOff) db.pragma('foreign_keys = OFF');
    const run = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${item.version}`);
      const now = userVersion(db);
      if (now !== item.version) {
        throw new MoshiError('E_DB', `迁移 ${item.file} 后版本号不符：期望 ${item.version}，实际 ${now}`);
      }
    });
    try {
      run();
    } catch (err) {
      if (err instanceof MoshiError) throw err;
      throw new MoshiError('E_DB', `迁移失败：${path.basename(item.file)}`, {
        file: item.file,
        cause: (err as Error).message,
      });
    } finally {
      if (fkOff) db.pragma('foreign_keys = ON');
    }
    applied.push(path.basename(item.file));
  }

  const vectorEnabled = ensureVectorTable(db, opts.vectorEnabled ?? hasVec0(db));
  return { from, to: target, applied, backupPath, vectorEnabled };
}

/** 已建的表清单（doctor 与测试用） */
export function listTables(db: Db): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}
