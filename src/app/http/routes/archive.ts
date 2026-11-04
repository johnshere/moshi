/**
 * 归档 REST 接口（详设 §4.3 / §9.4；台账 P2-15 / P2-19-A）。
 *
 * - `GET  /api/archive/topics`：归档台账列表（status / path / last_exported_at 等）
 * - `GET  /api/archive/topics/:slug`：单篇只读正文（归档页预览用；只读，不回写 DB）
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
import { getArchiveMetaBySlug, listArchiveMeta } from '../../../infra/sqlite/archiveRepo.js';
import { exportArchive } from '../../../core/archive/index.js';
import {
  applyProposal,
  mainFilePath,
  proposedFilePath,
  readArchiveMarkdown,
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

  app.get('/topics/:slug', async (req, reply) => {
    return guard(reply, () => {
      const slug = (req.params as { slug?: string }).slug;
      if (slug === undefined || slug === '') {
        throw new MoshiError('E_INPUT', 'slug 不能为空', { reason: 'slug_invalid' });
      }
      const meta = getArchiveMetaBySlug(db, slug);
      if (meta === null) {
        throw new MoshiError('E_NOT_FOUND', `未观察到归档主题：${slug}`, {
          reason: 'archive_slug_not_found',
          slug,
        });
      }
      const markdown = readArchiveMarkdown(archiveDir, meta.path);
      return {
        slug: meta.slug,
        topic_id: /^\d+$/.test(meta.topicId) ? Number(meta.topicId) : meta.topicId,
        title: meta.title,
        revision: meta.revision,
        status: meta.status,
        content_hash: meta.contentHash,
        path: meta.path,
        derived_at: meta.lastExportedAt,
        markdown,
        // 只在缺失时加字段，保持正常响应形状稳定（页面用 markdown === null 也能降级）
        ...(markdown === null ? { missing: true } : {}),
      };
    });
  });

  app.post('/export', async (req, reply) => {
    return guard(reply, () => {
      const body: unknown = req.body;
      let slug: string | undefined;
      let all = false;
      if (body !== undefined && body !== null) {
        if (typeof body !== 'object' || Array.isArray(body)) {
          throw new MoshiError('E_INPUT', '请求体必须是对象', { reason: 'export_body_invalid' });
        }
        const raw = body as { slug?: unknown; all?: unknown };
        if (raw.slug !== undefined) {
          if (typeof raw.slug !== 'string' || raw.slug.trim() === '') {
            throw new MoshiError('E_INPUT', 'slug 必须是非空字符串', { reason: 'slug_invalid' });
          }
          slug = raw.slug;
        }
        if (raw.all !== undefined) {
          if (typeof raw.all !== 'boolean') {
            throw new MoshiError('E_INPUT', 'all 必须是布尔值', { reason: 'all_invalid' });
          }
          all = raw.all;
        }
      }
      if (all && slug !== undefined) {
        throw new MoshiError('E_INPUT', 'slug 与 all 互斥，只能选一个目标', {
          reason: 'export_target_conflict',
        });
      }

      // 全量导出同步执行（详设 §8.3：全量 < 60s），不引入 job 队列
      const res = exportArchive(db, { archiveDir, roots, ...(slug === undefined ? {} : { slug }) });
      if (res === null) {
        throw new MoshiError('E_NOT_FOUND', `未观察到归档主题：${slug}`, {
          reason: 'archive_slug_not_found',
          slug,
        });
      }
      return {
        exported: res.exported,
        written: res.written,
        unchanged: res.unchanged,
        proposed: res.proposed,
        dir: res.dir,
        elapsed_ms: res.elapsedMs,
      };
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
