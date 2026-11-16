/**
 * 事务边界（详设 §3.5）。
 *
 * 为什么放在 infra：`BEGIN IMMEDIATE` 是数据库细节。core 需要"这几步要么全成要么全不成"，
 * 但不需要知道它叫 BEGIN IMMEDIATE、也不需要知道 better-sqlite3 的 transaction() 语义。
 *
 * 用 IMMEDIATE 而不是默认的 DEFERRED：WAL 下 DEFERRED 事务在升级写锁时可能撞
 * SQLITE_BUSY 且**不可重试**（已经读过数据了），IMMEDIATE 一开始就拿写锁。
 *
 * 撞锁重试：daemon（含 harvest/cron）与导入子进程会同时写同一个库，写者互斥。
 * 重试必须包住**整个事务函数**——从 BEGIN 到 COMMIT 整笔重来。不能在事务内部
 * 重试单条语句：事务内撞锁是快照冲突（读到的版本已过期），重试那一条只会基于
 * 旧快照继续写，只有回滚重来才是正确语义。所以：
 *
 * - 最外层事务：`retryBusySync` 包住 `BEGIN IMMEDIATE … COMMIT`；
 * - 嵌套调用（已在事务里 → SAVEPOINT）：**不重试**，锁在外层手里，重来由外层负责。
 */
import type { Db } from './db.js';
import { retryBusySync } from './db.js';

export function withTransaction<T>(db: Db, fn: () => T): T {
  const run = db.transaction(fn);
  if (db.inTransaction) return run();
  return retryBusySync(() => run.immediate());
}
