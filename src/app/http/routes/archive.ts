/**
 * 归档 REST 接口（详设 §4.8 / §9.4；台账 P2-15）。
 *
 * - `GET  /api/archive/topics`：归档台账列表（含三态 human_edited 与待决 proposal 路径）
 * - `POST /api/archive/proposed/:slug`：`.proposed.md` 三选一
 *     body `{action: accept_auto | keep_human | promote_human}`
 *
 * 只做参数校验与错误映射；判定/写盘/记账在 `core/archive/writer.ts`。
 * 注册留给 Lead：`await app.register(archiveRoutes, { prefix: '/api/archive', db: deps.db, cfg: deps.cfg })`。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isMoshiError, MoshiError } from '../../../domain/errors.js';
import type { Config } from '../../config.js';
import { dataPaths } from '../../config.js';
import type { Db } from '../../../infra/sqlite/db.js';
import { listArchiveMeta } from '../../../infra/sqlite/archiveRepo.js';
import {
  applyProposal,
  mainFilePath,
  proposedFilePath,
  type ProposalAction,
} from '../../../core/archive/writer.js';

export interface ArchiveRoutesOpts {
  db: Db;
  cfg: Config;
}

const ACTIONS: readonly ProposalAction[] = ['accept_auto', 'keep_human', 'promote_human'];

function sendMoshiError(reply: FastifyReply, err: MoshiError): FastifyReply {
  return reply
    .code(err.meta.httpStatus)
    .send({ error: err.code, message: err.message, detail: err.detail });
}

/** MoshiError → 对应状态码；未知异常原样抛给 Fastify（500） */
function guard<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    if (!isMoshiError(err)) throw err;
    return sendMoshiError(reply, err);
  }
}

export async function archiveRoutes(app: FastifyInstance, opts: ArchiveRoutesOpts): Promise<void> {
  const { db, cfg } = opts;
  const archiveDir = cfg.storage.archive_dir;
  const roots = [archiveDir, dataPaths(cfg).root];

  app.get('/topics', async (_req, reply) => {
    return guard(reply, () => {
      const items = listArchiveMeta(db).map((row) => {
        const mainFile = mainFilePath(archiveDir, row.slug, row.path);
        return {
          topic_id: /^\d+$/.test(row.topicId) ? Number(row.topicId) : row.topicId,
          slug: row.slug,
          title: row.title,
          path: row.path,
          revision: row.revision,
          content_hash: row.contentHash,
          last_exported_at: row.lastExportedAt,
          human_edited: row.humanEdited,
          status: row.status,
          proposed_path: row.humanEdited === 1 ? proposedFilePath(mainFile, row.slug) : null,
        };
      });
      return { items };
    });
  });

  app.post('/proposed/:slug', async (req, reply) => {
    return guard(reply, () => {
      const slug = (req.params as { slug?: string }).slug;
      if (slug === undefined || slug === '') {
        throw new MoshiError('E_INPUT', 'slug 不能为空', { reason: 'slug_invalid' });
      }

      const body: unknown = req.body;
      const rawAction =
        typeof body === 'object' && body !== null && 'action' in body
          ? (body as { action?: unknown }).action
          : undefined;
      if (typeof rawAction !== 'string' || !(ACTIONS as readonly string[]).includes(rawAction)) {
        throw new MoshiError('E_INPUT', `action 必须是 ${ACTIONS.join(' / ')}，收到 ${String(rawAction)}`, {
          reason: 'action_invalid',
          action: rawAction ?? null,
        });
      }

      // 额外白名单校验：archive_dir 与数据根必须在 cfg 里（写盘白名单在 writer 里兜底）
      const res = applyProposal(db, {
        slug,
        action: rawAction as ProposalAction,
        archiveDir,
        roots,
      });
      return {
        slug: res.slug,
        action: res.action,
        human_edited: res.humanEdited,
        revision: res.revision,
        content_hash: res.contentHash,
        path: res.path,
        history_path: res.historyPath,
      };
    });
  });
}
