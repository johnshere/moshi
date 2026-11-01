/**
 * `kill -9` 测试用的子进程（P0-15 验收："中途 kill -9 后重跑不丢不重"）。
 *
 * 它只做一件事：打开库、喊一声 `ready`、然后开始 harvest。
 * 父进程收到 `ready` 后等一会儿再 SIGKILL——这样被杀的时刻一定落在
 * "某批事务已经提交、下一批还没提交"的窗口里。
 *
 * 不放进 `tests/unit` 也不叫 `*.test.ts`：它不是测试，是被测试杀的东西。
 */
import { openDb } from '../../src/infra/sqlite/db.js';
import { harvest } from '../../src/core/write/harvest.js';

const file = process.argv[2];
if (file === undefined) {
  process.stderr.write('usage: harvest-child <db-file>\n');
  process.exit(2);
}

const { db } = openDb({ file });
process.stdout.write('ready\n');

const result = await harvest(db, { batchSize: 100, yieldBetweenBatches: true });
process.stdout.write(`${JSON.stringify(result)}\n`);
