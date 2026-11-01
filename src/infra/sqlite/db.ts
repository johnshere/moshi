/**
 * SQLite 连接（详设 §2.2 第 0 段 / §3.5）。
 *
 * PRAGMA 在**每次打开连接**时都要设，不能写进 DDL——迁移脚本只在建库时跑一次，
 * 而 PRAGMA 是连接级的。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { MoshiError } from '../../domain/errors.js';

export type Db = Database.Database;

export interface OpenOptions {
  /** 数据库文件路径，或 ':memory:' */
  file: string;
  /** 只读打开（doctor / 导出用） */
  readonly?: boolean;
  /** 是否尝试加载 sqlite-vec；默认 true */
  loadVector?: boolean;
}

export interface OpenResult {
  db: Db;
  /** sqlite-vec 是否可用 */
  vectorEnabled: boolean;
}

/** sqlite-vec 是可选依赖：没装或平台无二进制都不该让整个库打不开 */
function tryLoadVector(db: Db): boolean {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('sqlite-vec') as {
      load?: (d: Db) => void;
      getLoadablePath?: () => string;
    };
    if (typeof mod.load === 'function') {
      mod.load(db);
      return true;
    }
    if (typeof mod.getLoadablePath === 'function') {
      db.loadExtension(mod.getLoadablePath());
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function openDb(opts: OpenOptions): OpenResult {
  if (opts.file !== ':memory:') {
    mkdirSync(path.dirname(opts.file), { recursive: true });
  }

  let db: Db;
  try {
    db = new Database(opts.file, { readonly: opts.readonly ?? false });
  } catch (err) {
    throw new MoshiError('E_DB', `打不开数据库：${opts.file}`, { cause: (err as Error).message });
  }

  // 顺序有讲究：busy_timeout 要最先设，否则后面任何锁冲突都会立刻抛 SQLITE_BUSY
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  if (opts.readonly !== true) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }

  const vectorEnabled = opts.loadVector === false ? false : tryLoadVector(db);
  return { db, vectorEnabled };
}

export function closeDb(db: Db): void {
  if (db.open) db.close();
}

/** 健康检查用：几个关键能力是否可用 */
export function capabilities(db: Db): { fts5: boolean; json1: boolean; vector: boolean } {
  const check = (sql: string): boolean => {
    try {
      db.prepare(sql).get();
      return true;
    } catch {
      return false;
    }
  };
  return {
    fts5: check("SELECT 1 FROM pragma_module_list WHERE name = 'fts5'"),
    json1: check("SELECT json_valid('{}') AS v"),
    vector: check("SELECT 1 FROM pragma_module_list WHERE name = 'vec0'"),
  };
}
