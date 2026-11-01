/**
 * 结构化日志（详设 §11.1）：JSONL，字段固定，便于 grep 与后续指标计算。
 *
 * 输出两路：`<dataDir>/logs/moshi-YYYY-MM-DD.jsonl`（持久）+ stderr（前台可见）。
 * 事件名是约定的一部分（概设 §10.1），改动即破坏日志分析，需同步详设。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

/** 必须记录的事件（详设 §11.1） */
export const REQUIRED_EVENTS = [
  'harvest.start',
  'harvest.done',
  'export.start',
  'export.done',
  'gat.mode_change',
  'gat.breaker',
  'migrate.start',
  'migrate.done',
  'sidecar.start',
  'sidecar.ready',
  'sidecar.unload',
  'sidecar.exit',
  'archive.human_edited',
  'invariant.violation',
] as const;

export type RequiredEvent = (typeof REQUIRED_EVENTS)[number];

export interface LoggerOptions {
  level: string;
  /** 日志目录；为空则只输出到 stderr */
  dir?: string;
  /** 前台调试用：人类可读 */
  pretty?: boolean;
  /** 是否同时写 stderr（默认 true；测试里关掉避免噪音） */
  stderr?: boolean;
}

export interface BuiltLogger {
  logger: Logger;
  /** 关闭文件流（SIGTERM 时调用，确保 flush） */
  close: () => Promise<void>;
  /** 当前日志文件路径 */
  filePath: string | null;
}

const LOG_FILE_RE = /^moshi-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export function logFileName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `moshi-${y}-${m}-${d}.jsonl`;
}

/**
 * 日志里不该出现的东西——即便写库前会脱敏，日志是旁路，必须独立兜底。
 */
const REDACT_PATHS = [
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  '*.password',
  '*.secret',
  '*.token',
  '*.apiKey',
  'headers.authorization',
  'req.headers.authorization',
];

export function buildLogger(opts: LoggerOptions): BuiltLogger {
  const streams: pino.StreamEntry[] = [];

  let filePath: string | null = null;
  let fileStream: ReturnType<typeof createWriteStream> | null = null;

  if (opts.dir !== undefined && opts.dir !== '') {
    mkdirSync(opts.dir, { recursive: true });
    filePath = path.join(opts.dir, logFileName());
    fileStream = createWriteStream(filePath, { flags: 'a' });
    streams.push({ level: opts.level as pino.Level, stream: fileStream });
  }

  if (opts.stderr !== false) {
    streams.push({
      level: opts.level as pino.Level,
      stream: opts.pretty === true ? pino.transport({ target: 'pino-pretty' }) : process.stderr,
    });
  }

  if (streams.length === 0) {
    streams.push({ level: opts.level as pino.Level, stream: process.stderr });
  }

  const logger = pino(
    {
      level: opts.level,
      base: { pid: process.pid },
      // 详设 §11.1 的字段名是 ts，pino 默认叫 time
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '<REDACTED>' },
    },
    pino.multistream(streams, { dedupe: false }),
  );

  return {
    logger,
    filePath,
    close: async () => {
      await new Promise<void>((resolve) => {
        logger.flush(() => resolve());
      });
      if (fileStream !== null) {
        await new Promise<void>((resolve) => {
          fileStream?.end(() => resolve());
        });
      }
    },
  };
}

/**
 * 清理超过 keepDays 的日志文件，返回删除个数。
 * 启动时跑一次即可；失败不阻塞启动（日志不是核心功能）。
 */
export function pruneLogs(dir: string, keepDays: number, now: Date = new Date()): number {
  if (!existsSync(dir)) return 0;
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!LOG_FILE_RE.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full);
        removed += 1;
      }
    } catch {
      // 单个文件删不掉不影响其余文件
    }
  }
  return removed;
}
