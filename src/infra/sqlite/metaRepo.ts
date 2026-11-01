/**
 * `meta` 表读取（详设 §4.3 / §6.11）。
 *
 * `meta` 是键值表，放的是"整个库的状态"而不是某条事实的状态：`schema_rev`、
 * `layout_version`、`last_harvest_at` 等（DDL 约定键）。
 *
 * `schema_rev` 由 001_init.sql 的 AFTER INSERT/UPDATE/DELETE 触发器推高，
 * 所以它是**唯一可信的"库变了吗"信号**——会话内缓存靠它失效（详设 §6.11），
 * 派生投影（社区摘要、布局）靠它判新鲜度。
 */
import type { Db } from './db.js';

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** 当前 schema_rev；未初始化（极早期库/单元测试裸表）时按 0 处理 */
export function schemaRev(db: Db): number {
  const raw = getMeta(db, 'schema_rev');
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
