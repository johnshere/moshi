/**
 * 隐私接口 + 全库导出（P2-19A-12；详设 §4.3、概设 §5.5.1）。
 *
 * 两个插件（同一文件、由 Lead 分别注册不同前缀）：
 * - `privacyRoutes`  → `/api/privacy`：
 *     `GET  /overview` 隐私总览（schema moshi-privacy/1）
 *     `POST /purge`    二次确认 + dry_run 统计 + 单事务物理删除（先 audit）
 * - `exportRoutes`   → `/api/export`：
 *     `GET  /all`      流式 JSON 附件（schema moshi-export/1）
 *
 * DB 删除/计数全在 infra（core/ops/purge.ts 编排）；本文件只做参数校验与 HTTP 映射。
 */
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isMoshiError, MoshiError } from '../../../domain/errors.js';
import type { Db } from '../../../infra/sqlite/db.js';
import type { Config } from '../../config.js';
import {
  isPurgeScope,
  pageExportAnnotations,
  pageExportEdges,
  pageExportEntities,
  readArchiveTopicMetadata,
  readUserVersion,
} from '../../../infra/sqlite/auditRepo.js';
import { listFactsPage } from '../../../infra/sqlite/factRepo.js';
import { schemaRev } from '../../../infra/sqlite/metaRepo.js';
import {
  collectPrivacyOverview,
  planPurge,
  runPurge,
  type PrivacyOverview,
} from '../../../core/ops/purge.js';

export interface PrivacyRoutesOpts {
  db: Db;
  cfg: Config;
}

export interface ExportRoutesOpts {
  db: Db;
}

const EXPORT_PAGE = 500;

function sendMoshiError(reply: FastifyReply, err: MoshiError): FastifyReply {
  return reply
    .code(err.meta.httpStatus)
    .send({ error: err.code, message: err.message, detail: err.detail });
}

function guard<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    if (!isMoshiError(err)) throw err;
    return sendMoshiError(reply, err);
  }
}

function parsePurgeBody(raw: unknown): {
  scope: 'all' | 'facts' | 'sessions' | 'archive';
  dryRun: boolean;
} {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (body['confirm'] !== 'PURGE') {
    throw new MoshiError(
      'E_INPUT',
      '物理删除需要二次确认：body.confirm 必须为字符串 "PURGE"',
      { reason: 'confirm_required' },
    );
  }
  const scopeRaw = body['scope'] ?? 'all';
  if (!isPurgeScope(scopeRaw)) {
    throw new MoshiError('E_INPUT', 'scope 必须是 all | facts | sessions | archive', {
      reason: 'invalid_scope',
      scope: scopeRaw,
    });
  }
  return { scope: scopeRaw, dryRun: body['dry_run'] === true };
}

export async function privacyRoutes(
  app: FastifyInstance,
  opts: PrivacyRoutesOpts,
): Promise<void> {
  const { db, cfg } = opts;
  const archiveDir = cfg.storage.archive_dir;

  app.get('/overview', async (_req, reply): Promise<PrivacyOverview> => {
    reply.header('cache-control', 'no-store');
    return collectPrivacyOverview(db, {
      archiveDir,
      halfLifeDays: cfg.lifecycle.half_life_days,
    });
  });

  app.post('/purge', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return guard(reply, () => {
      const { scope, dryRun } = parsePurgeBody(req.body);
      if (dryRun) {
        const preview = planPurge(db, { scope, archiveDir });
        return reply.send({
          ok: true,
          dry_run: true,
          would_delete: {
            facts: preview.facts,
            edges: preview.edges,
            entities: preview.entities,
            annotations: preview.annotations,
            sessions: preview.sessions,
            archive_files: preview.archive_files,
          },
        });
      }
      const result = runPurge(db, { scope, archiveDir });
      return reply.send({
        ok: true,
        scope,
        deleted: result.deleted,
        archive_files_removed: result.archiveFilesRemoved,
        size_before_mb: result.sizeBeforeMb,
        size_after_mb: result.sizeAfterMb,
        elapsed_ms: result.elapsedMs,
      });
    });
  });
}

function annotationJson(row: {
  id: string;
  dedupKey: string;
  payloadJson: string;
  channel: string;
  receivedAt: string;
  harvestedAt: string | null;
  error: string | null;
}): string {
  return JSON.stringify({
    id: row.id,
    dedup_key: row.dedupKey,
    payload_json: row.payloadJson,
    channel: row.channel,
    received_at: row.receivedAt,
    harvested_at: row.harvestedAt,
    error: row.error,
  });
}

async function* exportChunks(db: Db, includeArchive: boolean): AsyncGenerator<string> {
  const exportedAt = new Date().toISOString();
  yield `{"schema":"moshi-export/1","exported_at":${JSON.stringify(exportedAt)},"facts":[`;

  let first = true;
  let after = 0;
  for (;;) {
    const page = listFactsPage(db, after, EXPORT_PAGE);
    if (page.length === 0) break;
    for (const item of page) {
      yield `${first ? '' : ','}${JSON.stringify(item.fact)}`;
      first = false;
      after = item.rowid;
    }
  }
  yield '],"edges":[';

  first = true;
  after = 0;
  for (;;) {
    const page = pageExportEdges(db, after, EXPORT_PAGE);
    if (page.length === 0) break;
    for (const item of page) {
      yield `${first ? '' : ','}${JSON.stringify(item.value)}`;
      first = false;
      after = item.rowid;
    }
  }
  yield '],"entities":[';

  first = true;
  after = 0;
  for (;;) {
    const page = pageExportEntities(db, after, EXPORT_PAGE);
    if (page.length === 0) break;
    for (const item of page) {
      yield `${first ? '' : ','}${JSON.stringify(item.value)}`;
      first = false;
      after = item.rowid;
    }
  }
  yield '],"annotations":[';

  first = true;
  after = 0;
  for (;;) {
    const page = pageExportAnnotations(db, after, EXPORT_PAGE);
    if (page.length === 0) break;
    for (const item of page) {
      yield `${first ? '' : ','}${annotationJson(item.value)}`;
      first = false;
      after = item.rowid;
    }
  }
  yield ']';

  if (includeArchive) {
    // 只带元数据，不带归档正文（详设 §9.7：原文不出境）
    yield `,"archive_topics":${JSON.stringify(readArchiveTopicMetadata(db))}`;
  }

  yield `,"meta":${JSON.stringify({ schema_rev: schemaRev(db), user_version: readUserVersion(db) })}}`;
}

export async function exportRoutes(
  app: FastifyInstance,
  opts: ExportRoutesOpts,
): Promise<void> {
  const { db } = opts;

  app.get('/all', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const includeArchive = query['include'] === 'archive';
    const date = new Date().toISOString().slice(0, 10);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="moshi-export-${date}.json"`);
    reply.header('cache-control', 'no-store');
    return reply.send(Readable.from(exportChunks(db, includeArchive)));
  });
}
