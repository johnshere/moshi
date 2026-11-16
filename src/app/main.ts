#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MoshiError } from '../domain/errors.js';
import { buildLogger, pruneLogs } from '../infra/log/logger.js';
import { SidecarClient } from '../infra/sidecar/client.js';
import { runCli, extractConfigArgv } from './cli/index.js';
import { DETACHED_ENV, detachDaemon, waitDaemonUp, wantsDetach } from './detach.js';
import { dataPaths, defaultConfigPath, loadConfig, resolveSources } from './config.js';
import { startCollectRunner, type CollectRunner } from './collectRunner.js';
import { AlreadyRunningError, boot } from './lifecycle.js';
import { inspectLock, removeLock } from './lock.js';
import { buildHttpApp } from './http/server.js';
import { startHarvestRunner, type HarvestRunner } from './harvestRunner.js';
import { startSchemaInferRunner, type SchemaInferRunner } from './schemaInferRunner.js';
import { startCommunityRunner, type CommunityRunner } from './communityRunner.js';
import { startLayoutRunner, type LayoutRunner } from './layoutRunner.js';
import { startScheduler, type Scheduler } from './jobs/scheduler.js';
import { startQueryLogRetention, type QueryLogRetention } from './jobs/queryLogRetention.js';
import { syncFactVectors } from '../infra/vec/index.js';
import { syncMissingFts } from '../infra/sqlite/ftsRepo.js';
import { Breaker } from '../core/read/breaker.js';
import { enforceGatGate } from '../core/ops/gate.js';
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
  // P3-A8：全局 `--config` 在 parseMode 之前剥离——否则 `--config x doctor`
  // 会被当成命令名 `--config`，落进 runCli 报"未知命令"。
  const global = extractConfigArgv(argv);
  if (global.missingValue) {
    process.stderr.write('--config 需要一个配置文件路径\n');
    return 2;
  }
  const args = global.argv;
  const mode = parseMode(args);

  // 后台模式：交给自启/计划任务/init 用，父进程立刻退出，子进程没有控制台。
  // 默认不带 --detach 时仍是前台 daemon（受当前窗口约束，Ctrl-C 停）。
  if (mode === 'daemon' && wantsDetach(args) && process.env[DETACHED_ENV] !== '1') {
    try {
      const spawned = detachDaemon();
      // 等子进程真的把锁写下来再返回：父进程 0 退出 = 后台确实起来了；
      // 超时返回 1，让计划任务的「失败后重启」策略接手，而不是假装成功。
      let lockPid: number | null = null;
      try {
        const cfgForWait = global.file === undefined ? loadConfig() : loadConfig({ file: global.file });
        const paths = dataPaths(cfgForWait);
        // 用 inspectLock 而不是 readLock：上一轮被强杀的 daemon 会留下陈旧锁，
        // 直接读文件会立刻"看到"一个已经死掉的 pid，报出假的成功。
        lockPid = await waitDaemonUp(async () => {
          const current = await inspectLock(paths.lock, cfgForWait.server.host);
          return current.kind === 'live' ? current.info.pid : null;
        });
      } catch {
        // 配置坏了/锁路径推不出来：不加判断，后台进程会自己把错误写进日志
      }
      if (lockPid === null) {
        process.stdout.write(`daemon 已转到后台（spawn pid=${spawned ?? '?'}），但 5s 内没拿到锁\n`);
        return 1;
      }
      process.stdout.write(`daemon 已在后台运行（pid=${lockPid}），关掉窗口也不会停\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`后台拉起 daemon 失败：${(err as Error).message}\n`);
      return 1;
    }
  }

  if (mode === 'version') {
    process.stdout.write(`moshi ${VERSION}\n`);
    return 0;
  }
  if (mode === 'cli') {
    return runCli(args, global.file === undefined ? {} : { file: global.file });
  }

  let cfg;
  try {
    cfg = global.file === undefined ? loadConfig() : loadConfig({ file: global.file });
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
  // P3-10 熔断：进程内单例，三个触发降档后不自动恢复（详设 §7.7）
  const breaker = new Breaker({
    onTrip: (trip) => {
      log.warn(
        { event: 'gat.breaker', reason: trip.reason, to: trip.to, at: new Date(trip.at).toISOString() },
        `GAT 熔断（${trip.reason}）：降为 ${trip.to}，需人工确认后恢复`,
      );
    },
  });
  let runner: HarvestRunner | undefined;
  let schemaRunner: SchemaInferRunner | undefined;
  let communityRunner: CommunityRunner | undefined;
  let collectRunner: CollectRunner | undefined;
  let layoutRunner: LayoutRunner | undefined;
  let scheduler: Scheduler | undefined;
  let queryLogRetention: QueryLogRetention | undefined;
  try {
    // sidecar 懒启动：不拉起、不阻塞；状态给 /api/status 与 UI 状态条用
    sidecar = new SidecarClient({ cfg, logger: log });
    instance = await boot(cfg, {
      // Fastify 接管全部 HTTP 面：/ui、/api/*、/mcp 挂在同一个端口。
      handlerFactory: async ({ db, cfg: booted, token }) => {
        // P3-09 双门槛硬门禁（详设 §7.6）：不达标的模式不许生效。
        // 只压有效值、不改配置文件——数据攒够了下次启动自动放行。
        const enforced = enforceGatGate(booted.model.gat_mode, db);
        if (enforced.refused) {
          log.warn(
            {
              event: 'model.gate_refused',
              mode: booted.model.gat_mode,
              reason: enforced.gate?.reason,
              current: enforced.gate?.current,
              required: enforced.gate?.required,
            },
            '双门槛未达标，拒绝启用 GAT（有效模式回退 off）',
          );
          booted.model.gat_mode = 'off';
        }
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
          // 子进程（历史导入）要读同一份配置：客户不该知道 daemon 启动时加了 --config。
          configFile: global.file ?? defaultConfigPath(),
          sidecar,
          breaker,
          onEnqueued: () => runner?.wake(),
          onStop: () => void shutdown('http.stop'),
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
    // P3-A8：source 实例由配置解析（`[[collect.sources]]` 的 id/root/enabled 都生效）
    collectRunner = startCollectRunner({
      db: instance.db,
      cfg,
      cursorsFile: paths.collectCursors,
      home: os.homedir(),
      sources: resolveSources(cfg, os.homedir()),
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

  // P2-17 调度器：cron + after 依赖 + 单写者串行（并发 1）。collect/layout 的内部
  // 定时器已收回，采集扫描改由调度器的 collect 伪任务驱动、布局挂在 export 之后
  // （D-69 / D-73 收口）。harvest/schema/community 的 runner 保留以复用 runOnce。
  try {
    scheduler = startScheduler({
      db: instance.db,
      cfg,
      log,
      collect: () => collectRunner?.runOnce() ?? null,
      harvest: () => runner?.runOnce() ?? null,
    });
  } catch (err) {
    log.error({ event: 'scheduler.start.failed', err: (err as Error).message }, 'scheduler failed');
  }

  // P2 接入层：query_log 保留清理（默认 3 天；0 = 永久）。启动跑一次，之后每天一次。
  try {
    queryLogRetention = startQueryLogRetention({
      db: instance.db,
      keepDays: cfg.storage.query_log_keep_days,
      log,
    });
  } catch (err) {
    log.error(
      { event: 'query_log.purge.start.failed', err: (err as Error).message },
      'query log retention failed',
    );
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
    scheduler?.stop();
    queryLogRetention?.stop();
    runner?.stop();
    schemaRunner?.stop();
    communityRunner?.stop();
    collectRunner?.stop();
    layoutRunner?.stop();
    await sidecar?.terminate();
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
