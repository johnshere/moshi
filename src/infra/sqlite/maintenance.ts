/**
 * 运维类操作（`moshi db ...` / `import` 收尾用）。
 *
 * 为什么需要"重建"而不是"一直靠触发器"：触发器维护的是**增量**，
 * 一旦有人绕过（批量 SQL 导入、外部工具改库、`PRAGMA foreign_keys=OFF` 的批量写），
 * 索引与度数就会与真相偏离。重建是"把派生数据按事实重算一遍"，
 * 相当于给数据库做一次对账。
 */
import { nowIso } from '../../domain/time.js';
import type { Db } from './db.js';
import { closeEdge } from './edgeRepo.js';
import { withTransaction } from './tx.js';

/** FTS5 外部内容表的重建：`INSERT INTO fact_fts(fact_fts) VALUES('rebuild')` */
export function rebuildFts(db: Db): void {
  db.prepare("INSERT INTO fact_fts(fact_fts) VALUES('rebuild')").run();
}

/**
 * 按 `edge` 重算 `fact.degree`。
 *
 * 触发器只在增删边时增减度数，一旦补历史边（`valid_to` 非空，不计数）与
 * 真实活跃边混在一起，度数就会漂。这里一次性按活跃边重算。
 */
export function rebuildDegree(db: Db): number {
  return withTransaction(db, () => {
    db.prepare('UPDATE fact SET degree = 0').run();
    const info = db
      .prepare(
        `UPDATE fact SET degree = (
           SELECT COUNT(*) FROM edge e
            WHERE e.valid_to IS NULL AND (e.src = fact.id OR e.dst = fact.id)
         )`,
      )
      .run();
    return info.changes;
  });
}

/**
 * 关闭反向重复的 `supersedes` 边（I-52）：旧版边抽取规则 4 建的是 `新 → 旧`，
 * 与写入冲突建的 `旧 → 新` 成对出现。只关「已有正向孪生边」的反向边（只设
 * valid_to、不删行），没有孪生的反向边不动——关掉它会丢掉唯一的取代证据。
 */
export function closeReversedSupersedes(db: Db, ts: string = nowIso()): number {
  return withTransaction(db, () => {
    const ids = db
      .prepare(
        `SELECT r.id FROM edge r
           JOIN fact s ON s.id = r.src
           JOIN fact d ON d.id = r.dst
          WHERE r.etype = 'supersedes' AND r.valid_to IS NULL
            AND s.valid_at > d.valid_at
            AND EXISTS (SELECT 1 FROM edge f
                         WHERE f.etype = 'supersedes' AND f.valid_to IS NULL
                           AND f.src = r.dst AND f.dst = r.src)
          ORDER BY r.id`,
      )
      .all() as { id: string }[];
    for (const { id } of ids) closeEdge(db, id, ts);
    return ids.length;
  });
}

/** `VACUUM` 必须在事务外跑；调用方负责确保没有别的事务在开 */
export function vacuum(db: Db): void {
  db.exec('VACUUM');
}

/** 表行数快照，`import` / `doctor` 的收尾输出用 */
export function tableCounts(db: Db): Record<string, number> {
  const tables = ['fact', 'edge', 'entity', 'episode', 'annotation', 'quarantine', 'audit'];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
    out[t] = row.n;
  }
  return out;
}
