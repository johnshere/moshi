/**
 * `moshi revoke <batch_id>`（P2-23 / 概设 §3.1.3③）。
 *
 * 直写是"现在就写"，所以必须有"现在就能撤"的对称入口：整批撤销后本批写入的
 * 事实、边、annotation 一起消失，每删一行留一条 audit。
 *
 * 为什么要在 CLI 里做而不是只留 MCP 工具：撤销是**补救**动作，往往发生在
 * Agent 已经发现写错之后、而它自己未必还活着。人得能从一个批次号直接收干净。
 */
import { existsSync } from 'node:fs';
import { dataPaths } from '../../config.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { revokeDirectBatch } from '../../mcp/directWrite.js';
import type { Command } from '../types.js';

export const revokeCommand: Command = {
  name: 'revoke',
  summary: '按批次撤销一次 MCP 直写（事实、边、标注一起回滚）',
  async run(ctx) {
    const batchId = ctx.args[0];
    if (batchId === undefined) {
      ctx.stderr(
        '用法：moshi revoke <batch_id>\n批次号由 memory_annotate 直写结果的 batch_id 返回（b_ 前缀）。\n',
      );
      return 2;
    }

    const paths = dataPaths(ctx.cfg);
    if (!existsSync(paths.db)) {
      ctx.stderr(`尚未观测到数据库：${paths.db}\n`);
      return 1;
    }

    const { db } = openDb({ file: paths.db });
    try {
      // 幂等：已迁移过的库这一步什么都不做
      migrate(db, { backupsDir: paths.backups });
      const out = revokeDirectBatch(db, batchId);
      const total = out.facts.length + out.edges.length + out.annotations.length;
      if (total === 0) {
        ctx.stdout(`批次 ${batchId} 没有可撤销的行（可能已撤销过，或批次号写错）\n`);
        return 1;
      }
      ctx.stdout(
        `已撤销批次 ${batchId}：事实 ${out.facts.length} 条、边 ${out.edges.length} 条、标注 ${out.annotations.length} 条\n`,
      );
      return 0;
    } finally {
      closeDb(db);
    }
  },
};
