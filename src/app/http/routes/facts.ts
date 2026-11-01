/**
 * Fact REST 路由（详设 §4.3）。
 *
 * Phase 0 只做最小集：列表、详情、纠正。
 * 分页用游标（`cursor` 是 base64 的 `{valid_at,id}`），不用 offset。
 */
import type { FastifyInstance } from 'fastify';
import { MoshiError } from '../../../domain/errors.js';
import { nowIso } from '../../../domain/time.js';
import type { Db } from '../../../infra/sqlite/db.js';
import * as factRepo from '../../../infra/sqlite/factRepo.js';
import * as auditRepo from '../../../infra/sqlite/auditRepo.js';
import type { Epistemic } from '../../../domain/enums.js';
import { withTransaction } from '../../../infra/sqlite/tx.js';
import { getVec } from '../../../infra/vec/index.js';

interface FactRoutesOpts {
  db: Db;
}

function decodeCursor(c?: string): { validAt: string; id: string } | null {
  if (c === undefined || c === '') return null;
  try {
    const json = Buffer.from(c, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { valid_at: string; id: string };
    if (typeof parsed.valid_at === 'string' && typeof parsed.id === 'string') {
      return { validAt: parsed.valid_at, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

function encodeCursor(validAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ valid_at: validAt, id })).toString('base64url');
}

export async function factRoutes(app: FastifyInstance, opts: FactRoutesOpts): Promise<void> {
  const db = opts.db;

  // GET /api/facts  列表
  app.get('/', async (req, _reply) => {
    const query = req.query as Record<string, string>;
    const limit = Math.min(Number(query.limit ?? '50'), 200);
    const cursor = decodeCursor(query.cursor);

    const filter: factRepo.SearchOptions = {
      q: query.q,
      scope: query.scope,
      ...(query.ftype ? { ftype: query.ftype.split(',') as factRepo.SearchOptions['ftype'] } : {}),
      ...(query.status ? { status: query.status.split(',') as factRepo.SearchOptions['status'] } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      // keyset 分页：游标条件在 SQL 层生效（sort: 'time' 与游标键一致）
      ...(cursor !== null ? { cursor: { validAt: cursor.validAt, id: cursor.id } } : {}),
      sort: 'time',
      limit: limit + 1, // 多取一条判断是否还有更多
    };

    const rows = factRepo.searchFacts(db, filter);

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor = hasMore && last !== undefined ? encodeCursor(last.validAt, last.id) : null;

    return {
      items: items.map((f) => ({
        id: f.id,
        content: f.content,
        ftype: f.ftype,
        confidence: f.confidence,
        strength: f.strength,
        epistemic_status: f.epistemicStatus,
        valid_at: f.validAt,
        valid_to: f.validTo,
        recorded_at: f.recordedAt,
      })),
      next_cursor: nextCursor,
      // total 是全库匹配数，不受游标影响
      total: factRepo.countMatching(db, { ...filter, cursor: undefined }),
    };
  });

  // GET /api/facts/:id  详情
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const fact = factRepo.getFact(db, id);
    if (fact === null) {
      return reply.code(404).send({ error: 'E_NOT_FOUND', message: `fact 不存在：${id}` });
    }
    const audits = auditRepo.auditByRow(db, 'fact', id);
    // 向量信息（P1-02）：详情弹窗展示该事实是否已进向量索引 + 前 8 维摘要
    const vec = getVec(db, id);
    // 字段命名必须与列表接口一致（snake_case JSON），前端按同一套字段渲染
    return {
      id: fact.id,
      content: fact.content,
      ftype: fact.ftype,
      confidence: fact.confidence,
      strength: fact.strength,
      importance: fact.importance,
      pool: fact.pool,
      epistemic_status: fact.epistemicStatus,
      scope: fact.scope,
      superseded_by: fact.supersededBy,
      valid_at: fact.validAt,
      valid_to: fact.validTo,
      recorded_at: fact.recordedAt,
      vector: vec === null
        ? { indexed: false }
        : {
            indexed: true,
            head: Array.from(vec.slice(0, 8)).map((x) => +x.toFixed(4)),
          },
      audits: audits.map((a) => ({
        field: a.field,
        before: a.beforeJson,
        after: a.afterJson,
        source: a.source,
        ts: a.ts,
      })),
    };
  });

  // PATCH /api/facts/:id  纠正（同 memory_correct 语义）
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const fact = factRepo.getFact(db, id);
    if (fact === null) {
      return reply.code(404).send({ error: 'E_NOT_FOUND', message: `fact 不存在：${id}` });
    }

    // 禁止改 content / attrs / canonical_key / value_hash
    for (const forbidden of ['content', 'attrs', 'canonical_key', 'value_hash']) {
      if (forbidden in body) {
        return reply.code(400).send({
          error: 'E_IMMUTABLE',
          message: `事实内容不可改：${forbidden}`,
        });
      }
    }

    const ts = nowIso();
    const changed: string[] = [];

    withTransaction(db, () => {
      if (typeof body.confidence === 'number' && body.confidence !== fact.confidence) {
        factRepo.setConfidence(db, id, {
          value: body.confidence,
          source: 'human',
          reason: String(body.reason ?? 'ui_correct'),
          ts,
        });
        changed.push('confidence');
      }
      if (typeof body.importance === 'number' && body.importance !== fact.importance) {
        factRepo.setImportance(db, id, body.importance, ts);
        changed.push('importance');
      }
      if (typeof body.strength === 'number' && body.strength !== fact.strength) {
        factRepo.setStrength(db, id, body.strength, ts);
        changed.push('strength');
      }
      if (typeof body.epistemic_status === 'string' && body.epistemic_status !== fact.epistemicStatus) {
        if (body.epistemic_status === 'invalidated') {
          factRepo.invalidate(db, id, { validTo: ts, status: 'invalidated' });
          changed.push('epistemic_status');
        } else {
          if (fact.validTo !== null) {
            throw new MoshiError(
              'E_IMMUTABLE',
              `事实已失效，不能改回 ${body.epistemic_status}`,
              { id, status: body.epistemic_status },
            );
          }
          factRepo.setEpistemicStatus(db, id, body.epistemic_status as Epistemic);
          changed.push('epistemic_status');
        }
      }
    });

    return { fact_id: id, changed };
  });
}
