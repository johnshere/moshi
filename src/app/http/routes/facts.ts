/**
 * Fact REST 路由（详设 §4.3）。
 *
 * Phase 0 只做最小集：列表、详情、纠正。
 * 分页用游标（`cursor` 是 base64url 的 `{sort:"time",valid_at,id}`，`sort=importance` 时是
 * `{sort:"importance",importance,id}`），不用 offset：offset 在并发写入下会漏行/重行。
 * 游标自带 `sort` 并与请求的 `sort` 显式对账，不一致直接 400，见 `decodeCursor`。
 * 排序只在服务端做（`sort=time|importance`，都是 keyset），前端只排当前页是禁止的
 * （台账 §4 P2-04 的坑）。
 */
import type { FastifyInstance } from 'fastify';
import { MoshiError } from '../../../domain/errors.js';
import { nowIso } from '../../../domain/time.js';
import type { Db } from '../../../infra/sqlite/db.js';
import * as factRepo from '../../../infra/sqlite/factRepo.js';
import * as auditRepo from '../../../infra/sqlite/auditRepo.js';
import * as episodeRepo from '../../../infra/sqlite/episodeRepo.js';
import type { Epistemic } from '../../../domain/enums.js';
import { withTransaction } from '../../../infra/sqlite/tx.js';
import { getVec } from '../../../infra/vec/index.js';

interface FactRoutesOpts {
  db: Db;
}

/** 列表排序键：只认两个值，拼错/缺省一律回落 `time`（深链不该因为一个参数白屏） */
type SortKey = 'time' | 'importance';

function parseSort(raw: string | string[] | undefined): SortKey {
  // Fastify 把重复 query 键（?sort=a&sort=b）解成数组，数组一律 400（台账 I-18）
  if (Array.isArray(raw)) {
    throw new MoshiError('E_INPUT', `sort 必须是单个值，收到数组`, { reason: 'sort_invalid' });
  }
  return raw === 'importance' ? 'importance' : 'time';
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * `limit` 解析（详设 §4.3：`limit∈[1,200] 整数`）。
 *
 * 分支必须显式写，不能靠 `Number()` 的隐式行为：`Number('-5') = -5` 进到 SQL 就是
 * `LIMIT -5`——SQLite 对负数 limit 的解释是「不限」，一个手搓 URL 就能一次拉走全库
 * （详设 §10.8 明禁一次拉全量）；`Number('abc') = NaN` 则会撞成 500 `SQLITE_MISMATCH`。
 * 所以非十进制正整数（`abc` / `1.9` / 空串 / `0` / 负数）一律 400，只有超上限仍夹住
 * （手搓 `limit=99999` 不该报错，前端固定 200）。
 */
function parseLimit(raw: string | string[] | undefined): number {
  if (Array.isArray(raw)) {
    throw new MoshiError('E_INPUT', `limit 必须是单个值，收到数组`, { reason: 'limit_invalid' });
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

/** 坏游标的统一出口：`cursor_invalid` 是 400，绝不静默回第 1 页 */
function cursorInvalid(why: string): never {
  throw new MoshiError('E_INPUT', `cursor 不可用：${why}`, { reason: 'cursor_invalid' });
}

/**
 * 游标 = base64url 的 `{sort:"time",valid_at,id}`（时间序）或
 * `{sort:"importance",importance,id}`（重要度序）。
 *
 * `sort` 必须写进载荷并在这里对账，三种失败都必须 400 而不是回第 1 页：
 * - 跨 sort（拿 time 游标配 `sort=importance`，或反向）→ `cursor_sort_mismatch`：
 *   两种序的键不同，照错键过滤会返回「以为在第 5 页、其实在第 1 页」的串页结果；
 * - 坏 base64 / 坏 JSON / 缺字段 / 没有 `sort` 的旧格式 → `cursor_invalid`：
 *   不接受"猜一个默认值继续"，翻页静默串页比报错难查得多（台账 D-98）。
 */
function decodeCursor(c: string | string[] | undefined, sort: SortKey): factRepo.SearchCursor | null {
  // Fastify 把重复 query 键（?cursor=a&cursor=b）解成数组，数组一律 400（台账 I-18）
  if (Array.isArray(c)) cursorInvalid('参数重复（数组入参）');
  // 只有"根本没传游标"才是第 1 页
  if (c === undefined || c === '') return null;
  // Buffer 的 base64 解码对非法字符是宽容的（直接跳过），先卡字符集，否则
  // `***` 会被解成空串、错误原因还会说成"JSON 坏了"，排查方向就歪了
  if (!/^[A-Za-z0-9_-]+$/.test(c)) cursorInvalid('不是合法的 base64url');
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
  } catch {
    cursorInvalid('不是合法的 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    cursorInvalid('载荷不是 JSON 对象');
  }
  const payload = parsed as Record<string, unknown>;
  const cursorSort = payload['sort'];
  if (cursorSort !== 'time' && cursorSort !== 'importance') {
    cursorInvalid('缺少 sort 字段（旧格式游标不再兼容）');
  }
  if (cursorSort !== sort) {
    throw new MoshiError(
      'E_INPUT',
      `游标排序键与 sort 不一致：cursor.sort=${String(cursorSort)}、sort=${sort}`,
      { reason: 'cursor_sort_mismatch', sort, cursor_sort: cursorSort },
    );
  }
  const id = payload['id'];
  if (typeof id !== 'string' || id === '') cursorInvalid('缺少 id');
  if (cursorSort === 'importance') {
    const importance = payload['importance'];
    if (typeof importance !== 'number' || !Number.isFinite(importance)) {
      cursorInvalid('缺少 importance');
    }
    return { sort: 'importance', importance, id };
  }
  const validAt = payload['valid_at'];
  if (typeof validAt !== 'string' || validAt === '') cursorInvalid('缺少 valid_at');
  return { sort: 'time', validAt, id };
}

function encodeCursor(sort: SortKey, last: { id: string; importance: number; validAt: string }): string {
  const payload =
    sort === 'importance'
      ? { sort: 'importance', importance: last.importance, id: last.id }
      : { sort: 'time', valid_at: last.validAt, id: last.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export async function factRoutes(app: FastifyInstance, opts: FactRoutesOpts): Promise<void> {
  const db = opts.db;

  /**
   * Fastify 默认把重复 query 键（?ftype=a&ftype=b）解成数组，筛选参数若放任数组
   * 会一路崩成 500（`.split` 不存在 / SQL 收到数组）。数组一律 400（台账 I-18）。
   */
  function single(raw: string | string[] | undefined, name: string): string | undefined {
    if (Array.isArray(raw)) {
      throw new MoshiError('E_INPUT', `${name} 必须是单个值，收到数组`, { reason: `${name}_invalid` });
    }
    return raw;
  }

  // GET /api/facts  列表
  app.get('/', async (req, reply) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    // 参数类错误在路由层就地转 400：本服务没有全局 errorHandler，抛出去会落到
    // Fastify 默认处理变成 500（`limit=abc` 以前就是这么变成 SQLITE_MISMATCH 的）
    let limit: number;
    let sort: SortKey;
    let cursor: factRepo.SearchCursor | null;
    let q: string | undefined;
    let scope: string | undefined;
    let ftype: string | undefined;
    let status: string | undefined;
    let from: string | undefined;
    let to: string | undefined;
    try {
      limit = parseLimit(query.limit);
      sort = parseSort(query.sort);
      cursor = decodeCursor(query.cursor, sort);
      q = single(query.q, 'q');
      scope = single(query.scope, 'scope');
      ftype = single(query.ftype, 'ftype');
      status = single(query.status, 'status');
      from = single(query.from, 'from');
      to = single(query.to, 'to');
    } catch (err) {
      if (!(err instanceof MoshiError)) throw err;
      return reply.code(400).send({ error: err.code, message: err.message, detail: err.detail });
    }

    const filter: factRepo.SearchOptions = {
      q,
      scope,
      ...(ftype ? { ftype: ftype.split(',') as factRepo.SearchOptions['ftype'] } : {}),
      ...(status ? { status: status.split(',') as factRepo.SearchOptions['status'] } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      // keyset 分页：游标条件在 SQL 层生效（游标键与 sort 成对，见 SearchCursor）
      ...(cursor !== null ? { cursor } : {}),
      sort,
      limit: limit + 1, // 多取一条判断是否还有更多
    };

    const rows = factRepo.searchFacts(db, filter);

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor = hasMore && last !== undefined ? encodeCursor(sort, last) : null;

    return {
      items: items.map((f) => ({
        id: f.id,
        content: f.content,
        ftype: f.ftype,
        confidence: f.confidence,
        strength: f.strength,
        // 表格视图的「重要性」列要它，`sort=importance` 的游标也是从这一列取值
        importance: f.importance,
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
    // 溯源数据（详设 §10.5 溯源档）：依赖链上下游各 3 跳 / 冲突对 / 反向 supersedes 链。
    // 检查器预算 < 50ms（详设 §10.8），详情本就按需请求，一次带全比多次 round-trip 便宜。
    const depends = factRepo.traceDepends(db, id);
    const conflicts = factRepo.listConflicts(db, id);
    const superseding = factRepo.listSuperseding(db, id);
    const sourceEpisode = fact.sourceEpisode === null ? null : episodeRepo.getById(db, fact.sourceEpisode);
    const digest = (d: factRepo.FactDigest): { id: string; content: string; valid_at: string; valid_to: string | null } => ({
      id: d.id,
      content: d.content,
      valid_at: d.validAt,
      valid_to: d.validTo,
    });
    // 字段命名必须与列表接口一致（snake_case JSON），前端按同一套字段渲染
    return {
      id: fact.id,
      content: fact.content,
      ftype: fact.ftype,
      confidence: fact.confidence,
      confidence_source: fact.confidenceSource,
      strength: fact.strength,
      importance: fact.importance,
      pool: fact.pool,
      epistemic_status: fact.epistemicStatus,
      attrs: fact.attrs,
      canonical_key: fact.canonicalKey,
      scope: fact.scope,
      superseded_by: fact.supersededBy,
      valid_at: fact.validAt,
      valid_to: fact.validTo,
      recorded_at: fact.recordedAt,
      source_episode:
        sourceEpisode === null
          ? null
          : {
              id: sourceEpisode.id,
              ts: sourceEpisode.ts,
              summary: sourceEpisode.summary,
              raw_path: sourceEpisode.rawPath,
            },
      span: fact.span,
      depends: { upstream: depends.upstream.map(digest), downstream: depends.downstream.map(digest) },
      conflicts: conflicts.map(digest),
      superseded: superseding.map(digest),
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
