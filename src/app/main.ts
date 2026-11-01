#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MoshiError } from '../domain/errors.js';
import { buildLogger, pruneLogs } from '../infra/log/logger.js';
import { SidecarClient } from '../infra/sidecar/client.js';
import { runCli } from './cli/index.js';
import { loadConfig } from './config.js';
import { AlreadyRunningError, boot } from './lifecycle.js';
import { removeLock } from './lock.js';
import { buildHttpApp } from './http/server.js';
import { startHarvestRunner, type HarvestRunner } from './harvestRunner.js';
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
  try {
    // sidecar 懒启动：不拉起、不阻塞；状态给 /api/status 与 UI 状态条用
    sidecar = new SidecarClient({ cfg, logger: log });
    instance = await boot(cfg, {
      // Fastify 接管全部 HTTP 面：/ui、/api/*、/mcp 挂在同一个端口。
      handlerFactory: async ({ db, cfg: booted, token }) => {
        // P1-22 写入闭环：annotation 入队后由这个 runner 消费成事实。
        // 先起 runner 再建 app——/mcp 上线时 wake 必须已经可用，否则第一批
        // "记住"要等 15s 兜底扫描才生效。
        runner = startHarvestRunner({ db, log });
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
