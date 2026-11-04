/**
 * 统一搜索路由（P2-19A-02，概设 §8.1「顶部搜索输入即查 alias + FTS5」）。
 *
 * `GET /api/search?q=<kw>&limit=<n>` 一次返回实体与事实两类命中：
 * - 实体：`entity.canonical_name` / `alias.alias` 子串命中，按活跃事实数降序、同数按 id 升序；
 * - 事实：复用 FTS5（`ftsRepo`）的 bm25 排序，带 content/canonical_key/importance/confidence。
 *
 * 契约是新接口 `moshi-search/1`，**不改任何既有 `/api/*` 契约**（D-89）。
 * 未命中返回 200 + 空数组（不是 404）；`q` 为空 / `limit` 非法一律 400 `E_INPUT`。
 * 路由由 `src/app/http/server.ts` 以 prefix=`/api/search` 注册（Lead 统一接线）。
 */
import type { FastifyInstance } from 'fastify';
import { orQuery, tokenizeForFts } from '../../../core/parse/tokenize.js';
import { MoshiError } from '../../../domain/errors.js';
import type { Db } from '../../../infra/sqlite/db.js';
import * as entityRepo from '../../../infra/sqlite/entityRepo.js';
import * as ftsRepo from '../../../infra/sqlite/ftsRepo.js';

/** 响应 schema 版本（只增不改；字段含义见任务卡 P2-19A-02） */
export const SEARCH_SCHEMA = 'moshi-search/1';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** 事实正文截断到 200 码点（`Array.from` 按码点切，不会切坏 emoji/代理对） */
const CONTENT_MAX_CODEPOINTS = 200;

export interface SearchRoutesOpts {
  db: Db;
}

/**
 * `limit` 解析：缺省 10；非十进制正整数一律 400；超上限夹到 50。
 * 与 `routes/facts.ts` 的 parseLimit 同口径（负数/小数/空串不能被 SQLite 当无限制）。
 */
function parseLimit(raw: string | string[] | undefined): number {
  if (Array.isArray(raw)) {
    throw new MoshiError('E_INPUT', 'limit 必须是单个值，收到数组', { reason: 'limit_invalid' });
  }
  if (raw === undefined) return DEFAULT_LIMIT;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new MoshiError('E_INPUT', `limit 必须是 1..${MAX_LIMIT} 的整数，收到「${raw}」`, {
      reason: 'limit_invalid',
    });
  }
  const n = Number(text);
  if (n < 1) {
    throw new MoshiError('E_INPUT', `limit 必须 ≥ 1，收到「${raw}」`, { reason: 'limit_invalid' });
  }
  return Math.min(n, MAX_LIMIT);
}

/** `q` 解析：数组/空串/纯空白都 400（空查询没有可检索的语义） */
function parseQ(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) {
    throw new MoshiError('E_INPUT', 'q 必须是单个值，收到数组', { reason: 'q_invalid' });
  }
  const q = (raw ?? '').trim();
  if (q === '') {
    throw new MoshiError('E_INPUT', 'q 不能为空', { reason: 'q_empty' });
  }
  return q;
}

function truncateCodepoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

export async function searchRoutes(app: FastifyInstance, opts: SearchRoutesOpts): Promise<void> {
  const db = opts.db;

  app.get('/', async (req, reply) => {
    const query = req.query as Record<string, string | string[] | undefined>;

    // 参数错误在路由层就地转 400：本服务没有全局 errorHandler（同 routes/facts.ts）
    let q: string;
    let limit: number;
    try {
      q = parseQ(query.q);
      limit = parseLimit(query.limit);
    } catch (err) {
      if (!(err instanceof MoshiError)) throw err;
      return reply.code(400).send({ error: err.code, message: err.message, detail: err.detail });
    }

    const startedAt = performance.now();

    // 实体：直接 SQL 子串检索（LIKE 已在 repo 内转义），不受 FTS token 口径影响
    const entities = entityRepo.searchEntitiesByName(db, q, limit).map((hit) => ({
      entity_id: hit.entity_id,
      canonical_name: hit.canonical_name,
      etype: hit.etype,
      fact_count: hit.fact_count,
      // 排序主键即活跃事实数：作为分数原样暴露，前端不需要再猜排序口径
      score: hit.fact_count,
    }));

    // 事实：与 recall/bm25 同一分词 → OR 查询串；查询串无有效 token 时不做 MATCH（返回空）
    const match = orQuery(tokenizeForFts(q));
    const facts =
      match === ''
        ? []
        : ftsRepo.searchFactsWithMeta(db, match, limit).map((hit) => ({
            fact_id: hit.fact_id,
            content: truncateCodepoints(hit.content, CONTENT_MAX_CODEPOINTS),
            canonical_key: hit.canonical_key,
            importance: hit.importance,
            confidence: hit.confidence,
            // bm25 输出为负数（越负越相关），对外统一成「越大越相关」并保留 6 位小数
            score: Math.round(-hit.bm25 * 1e6) / 1e6,
          }));

    const tookMs = performance.now() - startedAt;
    return {
      schema: SEARCH_SCHEMA,
      q,
      limit,
      entities,
      facts,
      took_ms: Math.max(0, Math.round(tookMs * 1000) / 1000),
    };
  });
}
