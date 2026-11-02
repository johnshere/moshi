/**
 * `moshi layout [--full]`（P2-01 / 详设 §10.4）。
 *
 * 布局是后台算的（决议 D16），前端只渲染；所以必须有一个能手动触发一次的入口：
 * 首次建库、从备份恢复、改过力参数之后，用户要能立刻把坐标算出来，而不是等
 * daemon 的下一轮节流。
 *
 * 默认增量：只给新事实落位，老节点一动不动（空间记忆不变）。`--full` 才重排整张图。
 */
import { existsSync } from 'node:fs';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { dataPaths } from '../../config.js';
import { runLayoutJob } from '../../jobs/layout.job.js';
import type { Command } from '../types.js';

const USAGE = '用法：moshi layout [--full]\n  默认增量：只给新事实落位，老节点坐标不动\n  --full      全量重算（300 ticks，整张图重新收敛）\n';

export const layoutCommand: Command = {
  name: 'layout',
  summary: '重算 3D 布局坐标（worker 线程；--full 强制全量）',
  async run(ctx) {
    const full = ctx.args.includes('--full');
    const unknown = ctx.args.filter((a) => a !== '--full');
    if (unknown.length > 0) {
      ctx.stderr(`未知参数：${unknown.join(' ')}\n${USAGE}`);
      return 2;
    }

    const paths = dataPaths(ctx.cfg);
    if (!existsSync(paths.db)) {
      ctx.stderr(`尚未观测到数据库：${paths.db}\n`);
      return 1;
    }

    const { db } = openDb({ file: paths.db });
    try {
      migrate(db, { backupsDir: paths.backups });
      const stats = await runLayoutJob({ db, cfg: ctx.cfg, ...(full ? { full: true } : {}) });
      if (stats.mode === 'skip') {
        const reason = stats.skipReason === 'no-facts' ? '库里还没有可见事实' : '没有新事实需要落位';
        ctx.stdout(`布局未重算：${reason}（共 ${String(stats.total)} 个节点，版本 ${String(stats.version)}）\n`);
        return 0;
      }
      const how = stats.mode === 'full' ? '全量' : '增量';
      const fallback = stats.fellBackToFull ? '，增量位移超阈值已转全量' : '';
      ctx.stdout(
        `布局完成：${how}（${String(stats.ticks)} ticks）· 节点 ${String(stats.total)}（新增 ${String(stats.newFacts)}）` +
          `· 平均位移 ${stats.avgDisplacement.toFixed(2)} · 写入 ${String(stats.wrote)} 行` +
          `· 版本 ${String(stats.version)} · 用时 ${String(stats.ms)}ms · worker 线程 ${String(stats.workerThreadId)}${fallback}\n`,
      );
      return 0;
    } finally {
      closeDb(db);
    }
  },
};
