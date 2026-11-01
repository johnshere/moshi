#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MoshiError } from '../domain/errors.js';
import { buildLogger, pruneLogs } from '../infra/log/logger.js';
import { runCli } from './cli/index.js';
import { loadConfig } from './config.js';
import { AlreadyRunningError, boot } from './lifecycle.js';
import { removeLock } from './lock.js';

export const VERSION = '0.1.0';

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
  try {
    instance = await boot(cfg);
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

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ event: 'daemon.stop', signal }, 'shutting down');
    await instance.close();
    await built.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows 上 SIGTERM 无法投递给其他进程（TerminateProcess 直接杀），
  // 所以正常退出路径再兜一次底；被强杀时靠锁的陈旧判定接管（见 lock.ts）。
  process.on('exit', () => {
    removeLock(instance.paths.lock);
  });

  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main(process.argv.slice(2)).then((code) => {
    // daemon 模式要挂着不退出，只有短命令才设 exitCode
    if (code !== 0) process.exitCode = code;
  });
}
