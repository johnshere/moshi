/**
 * 设置页后端（P2-19A-06）：配置读写 + 维护重建。
 *
 * - `GET  /api/config`：当前生效配置的**安全子集**（绝不返回 token / MCP 闸门等）
 * - `PUT  /api/config`：body `{patch:{...}}`，白名单键 + 深层合并 + 类型/范围校验，
 *   原子写回 TOML 配置文件；启动期键（port/data_dir/archive_dir）返回 restart_required
 * - `POST /api/maintenance/rebuild`：`{target:'fts'|'vec'|'degree'|'all', dry_run?}`
 *   复用既有 rebuild/sync 函数，返回 before/after mismatch 计数
 *
 * 注册留给 Lead：`await app.register(configRoutes, { prefix: '/api', db: deps.db, cfg: deps.cfg, sidecar: deps.sidecar })`
 * （prefix 是 `/api`，本文件内路由为 `/config`、`/maintenance/rebuild`）。
 *
 * 纪律：不新开 `/api/*` 契约之外的东西；写配置走 `src/infra/fs` 白名单安全写。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isMoshiError, MoshiError } from '../../../domain/errors.js';
import type { Db } from '../../../infra/sqlite/db.js';
import type { WriteRoots } from '../../../infra/fs/safeWrite.js';
import { readIndexInputs } from '../../../infra/sqlite/diagRepo.js';
import { syncMissingFts } from '../../../infra/sqlite/ftsRepo.js';
import { rebuildDegree, rebuildFts } from '../../../infra/sqlite/maintenance.js';
import { syncFactVectors, vectorDisabled } from '../../../infra/vec/index.js';
import {
  checkConfigDocument,
  dataPaths,
  defaultConfigPath,
  EDITABLE_CONFIG_ENTRIES,
  findEditableConfigEntry,
  isValidCronExpression,
  loadConfig,
  mergeConfigDocument,
  PUBLIC_CONFIG_SCHEMA,
  readConfigDocument,
  RESTART_REQUIRED_PATHS,
  writeConfigDocument,
  type Config,
} from '../../config.js';

/** 向量编码器的最小接口（daemon 传 `SidecarClient` 即可） */
export interface VecEncoderLike {
  encode(texts: string[]): Promise<number[][] | null>;
  ensureStarted?(): Promise<unknown>;
}

export interface ConfigRoutesOpts {
  db: Db;
  cfg: Config;
  /** 配置文件路径；不传则用 `$MOSHI_CONFIG` / `<home>/.moshi/config.toml` */
  configPath?: string;
  /** 覆盖 home（测试用） */
  home?: string;
  /** 写盘白名单根；默认 `[dataPaths(cfg).root]` */
  roots?: WriteRoots;
  /** 维护重建里的向量编码；不传时 `vec` 实跑返回 503，dry_run 仍可计数 */
  sidecar?: VecEncoderLike;
}

const TARGETS = ['fts', 'vec', 'degree', 'all'] as const;
type RebuildTarget = (typeof TARGETS)[number];

interface MismatchCounts {
  fts_missing: number;
  vec_missing: number;
  degree_mismatch: number;
}

function mismatchCounts(db: Db): MismatchCounts {
  const idx = readIndexInputs(db);
  return {
    fts_missing:
      idx.fts_rows === null ? idx.fact_rows : Math.max(0, idx.fact_rows - idx.fts_rows),
    vec_missing:
      idx.vector_disabled || idx.vec_rows === null
        ? idx.vector_disabled
          ? 0
          : idx.fact_rows
        : Math.max(0, idx.fact_rows - idx.vec_rows),
    degree_mismatch: idx.degree_mismatch,
  };
}

function sendMoshiError(reply: FastifyReply, err: MoshiError): FastifyReply {
  return reply
    .code(err.meta.httpStatus)
    .send({ error: err.code, message: err.message, detail: err.detail });
}

/** MoshiError → 对应状态码；未知异常原样抛给 Fastify（500） */
async function guard<T>(
  reply: FastifyReply,
  fn: () => T | Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (!isMoshiError(err)) throw err;
    return sendMoshiError(reply, err);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 把嵌套 patch 展平成 `section.key` → 值；数组/null 一律非法 */
function flattenPatch(
  patch: Record<string, unknown>,
  prefix = '',
): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const dotted = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(value)) {
      out.push(...flattenPatch(value, dotted));
    } else {
      out.push({ path: dotted, value });
    }
  }
  return out;
}

/** GET 的对外视图：只列白名单键，绝不整段 dump Config */
function publicConfig(cfg: Config, configPath: string): Record<string, unknown> {
  return {
    schema: PUBLIC_CONFIG_SCHEMA,
    config: {
      ingest: { harvest_cron: cfg.ingest.harvest_cron },
      archive: {
        export_cron: cfg.archive.export_cron,
        dirty_threshold_facts: cfg.archive.dirty_threshold_facts,
        dirty_threshold_confidence: cfg.archive.dirty_threshold_confidence,
        min_facts: cfg.archive.min_facts,
        history_keep: cfg.archive.history_keep,
      },
      layout: { enabled: cfg.layout.enabled, interval_ms: cfg.layout.interval_ms },
      collect: {
        enabled: cfg.collect.enabled,
        interval_ms: cfg.collect.interval_ms,
        llm_scan: cfg.collect.llm_scan,
      },
      http: { port: cfg.server.port },
      storage: {
        data_dir: cfg.storage.data_dir,
        archive_dir: cfg.storage.archive_dir,
        backup_keep: cfg.storage.backup_keep,
      },
    },
    meta: { config_path: configPath },
  };
}

export async function configRoutes(
  app: FastifyInstance,
  opts: ConfigRoutesOpts,
): Promise<void> {
  const { db, cfg: initialCfg } = opts;
  const configPath = opts.configPath ?? defaultConfigPath(opts.home);
  const roots: WriteRoots = opts.roots ?? [dataPaths(initialCfg).root];

  app.get('/config', async (_req, reply) => {
    // 每次按配置文件重新加载，避免进程内旧 cfg 与磁盘不一致（PUT 后立刻 GET 要能看到）
    let cfg = initialCfg;
    try {
      cfg = loadConfig({ file: configPath });
    } catch {
      // 配置文件暂时读不出来时退回启动时的 cfg，GET 不因此 500
    }
    reply.header('cache-control', 'no-store');
    return publicConfig(cfg, configPath);
  });

  app.put('/config', async (req, reply) => {
    return guard(reply, () => {
      const body = req.body;
      if (!isPlainObject(body) || !isPlainObject(body['patch'])) {
        throw new MoshiError('E_INPUT', '请求体必须是 {patch:{...}}', {
          reason: 'body_invalid',
        });
      }
      const leaves = flattenPatch(body['patch']);
      if (leaves.length === 0) {
        throw new MoshiError('E_INPUT', 'patch 不能为空', { reason: 'patch_empty' });
      }

      const patch: Record<string, Record<string, unknown>> = {};
      const applied: string[] = [];
      for (const leaf of leaves) {
        const entry = findEditableConfigEntry(leaf.path);
        if (entry === undefined) {
          throw new MoshiError('E_INPUT', `不允许修改配置键：${leaf.path}`, {
            reason: 'unknown_key',
            key: leaf.path,
          });
        }
        const value = leaf.value;
        if (entry.path.endsWith('_cron')) {
          if (typeof value !== 'string' || !isValidCronExpression(value)) {
            throw new MoshiError('E_INPUT', `${entry.path} 必须是 5 段 cron 表达式`, {
              reason: 'cron_invalid',
              key: entry.path,
              value,
            });
          }
        }
        if (entry.path.endsWith('.interval_ms')) {
          if (
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < 1000
          ) {
            throw new MoshiError('E_INPUT', `${entry.path} 必须是 ≥1000 的整数毫秒`, {
              reason: 'interval_invalid',
              key: entry.path,
              value,
            });
          }
        }
        const section = patch[entry.section] ?? {};
        section[entry.key] = value;
        patch[entry.section] = section;
        if (!applied.includes(entry.path)) applied.push(entry.path);
      }

      const raw = readConfigDocument(configPath);
      const merged = mergeConfigDocument(raw, patch);
      const checked = checkConfigDocument(merged);
      if (!checked.ok) {
        throw new MoshiError('E_INPUT', '配置值不合法', {
          reason: 'value_invalid',
          issues: checked.issues,
        });
      }
      writeConfigDocument(configPath, merged, roots);
      const restartRequired = applied.some((path) => RESTART_REQUIRED_PATHS.includes(path));
      return {
        ok: true,
        schema: PUBLIC_CONFIG_SCHEMA,
        applied,
        restart_required: restartRequired,
      };
    });
  });

  app.post('/maintenance/rebuild', async (req, reply) => {
    return guard(reply, async () => {
      const body = req.body;
      if (!isPlainObject(body)) {
        throw new MoshiError('E_INPUT', '请求体必须是 JSON 对象', { reason: 'body_invalid' });
      }
      const target = body['target'];
      if (typeof target !== 'string' || !(TARGETS as readonly string[]).includes(target)) {
        throw new MoshiError('E_INPUT', `target 必须是 ${TARGETS.join(' / ')}`, {
          reason: 'target_invalid',
          value: target,
        });
      }
      const dryRunRaw = body['dry_run'];
      if (dryRunRaw !== undefined && typeof dryRunRaw !== 'boolean') {
        throw new MoshiError('E_INPUT', 'dry_run 必须是布尔值', { reason: 'dry_run_invalid' });
      }
      const dryRun = dryRunRaw === true;
      const t = target as RebuildTarget;
      const startedAt = Date.now();
      const before = mismatchCounts(db);
      const skipped: string[] = [];
      const details: Record<string, unknown> = {};

      if (!dryRun) {
        if (t === 'fts' || t === 'all') {
          const added = syncMissingFts(db);
          rebuildFts(db);
          details['fts_added'] = added;
        }
        if (t === 'degree' || t === 'all') {
          details['degree_rows'] = rebuildDegree(db);
        }
        if (t === 'vec' || t === 'all') {
          if (vectorDisabled(db)) {
            skipped.push('vec');
          } else if (opts.sidecar === undefined) {
            if (t === 'vec') {
              throw new MoshiError('E_BUSY', '向量编码服务不可用（sidecar 未注入）', {
                reason: 'sidecar_unavailable',
              });
            }
            skipped.push('vec');
          } else {
            await opts.sidecar.ensureStarted?.();
            const res = await syncFactVectors(db, {
              encode: async (content) => {
                const vectors = await opts.sidecar!.encode([content]);
                const first = vectors?.[0];
                return first === undefined ? null : Float32Array.from(first);
              },
              batchSize: 200,
              concurrency: 4,
            });
            details['vec'] = res;
          }
        }
      }

      const after = dryRun ? before : mismatchCounts(db);
      return {
        ok: true,
        target: t,
        dry_run: dryRun,
        before,
        after,
        elapsed_ms: Date.now() - startedAt,
        ...(skipped.length === 0 ? {} : { skipped }),
        ...(Object.keys(details).length === 0 ? {} : { details }),
      };
    });
  });
}

/** GET /api/config 白名单键（测试/文档引用） */
export const CONFIG_PUBLIC_PATHS: readonly string[] = EDITABLE_CONFIG_ENTRIES.map(
  (entry) => entry.path,
);
