/**
 * 事务边界（详设 §3.5）。
 *
 * 为什么放在 infra：`BEGIN IMMEDIATE` 是数据库细节。core 需要"这几步要么全成要么全不成"，
 * 但不需要知道它叫 BEGIN IMMEDIATE、也不需要知道 better-sqlite3 的 transaction() 语义。
 *
 * 用 IMMEDIATE 而不是默认的 DEFERRED：WAL 下 DEFERRED 事务在升级写锁时可能撞
 * SQLITE_BUSY 且**不可重试**（已经读过数据了），IMMEDIATE 一开始就拿写锁。
 */
import type { Db } from './db.js';

export function withTransaction<T>(db: Db, fn: () => T): T {
  const run = db.transaction(fn);
  return run.immediate();
}
