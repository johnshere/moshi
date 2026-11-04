#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MoshiError } from '../domain/errors.js';
import { buildLogger, pruneLogs } from '../infra/log/logger.js';
import { SidecarClient } from '../infra/sidecar/client.js';
import { runCli } from './cli/index.js';
import { dataPaths, loadConfig } from './config.js';
import { startCollectRunner, type CollectRunner } from './collectRunner.js';
import { AlreadyRunningError, boot } from './lifecycle.js';
import { removeLock } from './lock.js';
import { buildHttpApp } from './http/server.js';
import { startHarvestRunner, type HarvestRunner } from './harvestRunner.js';
import { startSchemaInferRunner, type SchemaInferRunner } from './schemaInferRunner.js';
import { startCommunityRunner, type CommunityRunner } from './communityRunner.js';
import { startLayoutRunner, type LayoutRunner } from './layoutRunner.js';
import { syncFactVectors } from '../infra/vec/index.js';
import { syncMissingFts } from '../infra/sqlite/ftsRepo.js';
import { VERSION } from './version.js';

export { VERSION };

export type Mode = 'daemon' | 'cli' | 'version';

const MODES: readonly Mode[] = ['daemon', 'cli', 'version'];

export function parseMode(argv: readonly string[]): Mode {
  const first = argv[0];
  if (first === undefined || first === '') return 'daemon';
  if (first === '--version' || first === '-v' || first === 'version') return 'version';
  if (first === '--help' || first === '-h' || first === 'help') return 'cli';
  if ((MODES as readonly string[]).includes(first)) return first as Mode;
  // 其余一律当 CLI 命令名，由 runCli 报「未知命令」
  return 'cli';
}

export async function main(argv: readonly string[]): Promise<number> {
  const mode = parseMode(argv);

  if (mode === 'version') {
    process.stdout.write(`moshi ${VERSION}\n`);
    return 0;
  }
  if (mode === 'cli') {
    return runCli(argv);
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const e = err as MoshiError;
    process.stderr.write(`配置错误：${e.message}\n`);
    return 1;
  }

  const logsDir = path.join(cfg.storage.data_dir, 'logs');
  const built = buildLogger({ level: cfg.log.level, dir: logsDir, stderr: true });
  const log = built.logger;
  pruneLogs(logsDir, cfg.log.keep_days);

  let instance;
  let sidecar: SidecarClient | undefined;
  let runner: HarvestRunner | undefined;
  let schemaRunner: SchemaInferRunner | undefined;
  let communityRunner: CommunityRunner | undefined;
  let collectRunner: CollectRunner | undefined;
  let layoutRunner: LayoutRunner | undefined;
  try {
    // sidecar 懒启动：不拉起、不阻塞；状态给 /api/status 与 UI 状态条用
    sidecar = new SidecarClient({ cfg, logger: log });
    instance = await boot(cfg, {
      // Fastify 接管全部 HTTP 面：/ui、/api/*、/mcp 挂在同一个端口。
      handlerFactory: async ({ db, cfg: booted, token }) => {
        // P1-22 写入闭环：annotation 入队后由这个 runner 消费成事实。
        // 先起 runner 再建 app——/mcp 上线时 wake 必须已经可用，否则第一批
        // "记住"要等 15s 兜底扫描才生效。
        runner = startHarvestRunner({
          db,
          log,
          consolidate: { maxContentBytes: booted.ingest.max_fact_bytes },
          procedures: { maxContentBytes: booted.ingest.max_fact_bytes },
        });
        // P1-24 互斥裁决的前置：ontology 里得有谓词基数性。启动即算一次，
        // 之后按 schema_rev 脏检查兜底重算（见 schemaInferRunner）。
        schemaRunner = startSchemaInferRunner({ db, log });
        // P2-11 社区划分：归档/UI 社区视觉的数据源。启动即算一次，
        // 之后按 schema_rev + 活跃边数脏检查兜底重算（见 communityRunner）。
        communityRunner = startCommunityRunner({ db, log });
        const { server } = await buildHttpApp({
          db,
          cfg: booted,
          token,
          sidecar,
          onEnqueued: () => runner?.wake(),
        });
        return server;
      },
    });
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      // 第二个实例不是错误：打印去向并退出 0（概设 §1.1 第 3 条）
      process.stdout.write(`${err.message}\n`);
      await built.close();
      return 0;
    }
    log.error({ event: 'boot.failed', err: (err as Error).message }, '启动失败');
    process.stderr.write(`启动失败：${(err as Error).message}\n`);
    await built.close();
    return 1;
  }

  log.info(
    { event: 'daemon.start', port: instance.port, data_dir: cfg.storage.data_dir },
    'daemon started',
  );

  // P1-03 全文检索：启动即补齐历史事实的 FTS 行（先于向量同步，纯本地无依赖）
  try {
    const n = syncMissingFts(instance.db);
    if (n > 0) log.info({ event: 'fts.sync', synced: n }, 'fts rows synced');
  } catch (err) {
    log.error({ event: 'fts.sync.failed', err: (err as Error).message }, 'fts sync failed');
  }

  // P1-24 启动即补一次谓词基数性：已有库的历史事实不必等 60s 兜底轮询，
  // 否则第一次查询时 ontology 还是空的、互斥裁决仍不触发。
  try {
    const schema = schemaRunner?.runOnce() ?? null;
    if (schema !== null) {
      log.info({ event: 'schema.infer.boot', predicates: schema.predicates.length }, 'schema infer done');
    }
  } catch (err) {
    log.error({ event: 'schema.infer.failed', err: (err as Error).message }, 'schema infer failed');
  }

  // P2-21 采集扫描：daemon 起来后接管会话文件的定时扫描（阶段 1 埋点解析 +
  // 阶段 2 兜底），入队后唤醒 harvest。P2-17 调度器落地后换成它驱动，扫描逻辑不动。
  // home 与配置同源（`os.homedir()`）——配置读一个 home、会话扫另一个，是 P0 踩过的坑。
  try {
    const paths = dataPaths(cfg);
    collectRunner = startCollectRunner({
      db: instance.db,
      cfg,
      cursorsFile: paths.collectCursors,
      home: os.homedir(),
      genericInbox: path.join(paths.root, 'inbox'),
      log,
      onEnqueued: () => runner?.wake(),
    });
    if (!cfg.collect.enabled) {
      log.info({ event: 'collect.disabled' }, 'collect runner disabled by config');
    }
  } catch (err) {
    log.error({ event: 'collect.start.failed', err: (err as Error).message }, 'collect runner failed');
  }

  // P2-01 布局：harvest 落库的新事实按节流（默认 60s）补坐标。没有新事实时
  // 一次 `countUnlaidFacts` 就跳过，不会每分钟白起一个 worker。
  // 坐标只在这个 worker 线程里算，主线程继续扛 HTTP / MCP（概设 §8.9 纪律 1）。
  try {
    if (cfg.layout.enabled) {
      layoutRunner = startLayoutRunner({ db: instance.db, cfg, log });
    } else {
      log.info({ event: 'layout.disabled' }, 'layout runner disabled by config');
    }
  } catch (err) {
    log.error({ event: 'layout.start.failed', err: (err as Error).message }, 'layout runner failed');
  }

  // P1-02 向量同步：启动后延迟一轮事件循环再补索引（encode 走 sidecar）。
  // 先等 sidecar 就绪再批量编码——sync 撞上懒启动窗口（2-5s）会让首轮
  // encode 全部返回 null。只做一次、失败/无数据自然结束；sidecar 不可用时
  // encode 返回 null → missing（不炸，正确降级为 no_vector）。
  void (async () => {
    try {
      await sidecar?.ensureStarted();
      const res = await syncFactVectors(instance.db, {
        encode: async (content) => {
          if (sidecar === undefined) return null;
          const v = await sidecar.encode([content]);
          return v === null ? null : Float32Array.from(v[0]!);
        },
        batchSize: 200,
        concurrency: 4,
      });
      log.info({ event: 'vec.sync', ...res }, 'vector index synced');
    } catch (err) {
      log.error({ event: 'vec.sync.failed', err: (err as Error).message }, 'vector sync failed');
    }
  })();

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ event: 'daemon.stop', signal }, 'shutting down');
    // 先停消费者：正在跑的一轮 harvest 会自己把事务收尾，停掉就不再唤醒下一轮
    runner?.stop();
    schemaRunner?.stop();
    communityRunner?.stop();
    collectRunner?.stop();
    layoutRunner?.stop();
    await sidecar?.shutdown();
    await instance.close();
    await built.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows 上 SIGTERM 无法投递给其他进程（TerminateProcess 直接杀），
  // 所以正常退出路径再兜一次底；被强杀时靠锁的陈旧判定接管（见 lock.ts）。
  process.on('exit', () => {
    removeLock(instance.paths.lock, [instance.paths.root]);
  });

  // daemon 模式必须挂着不退出——http.Server 在某些环境下（Windows 后台运行）
  // 不会自动保持事件循环，需要显式保持。
  setInterval(() => {}, 1 << 30);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main(process.argv.slice(2)).then((code) => {
    // daemon 模式要挂着不退出，只有短命令才设 exitCode
    if (code !== 0) process.exitCode = code;
  });
}
