/**
 * P2-26 历史查询列表 / 回放状态机（纯逻辑）。
 *
 * 为什么不是 React 组件测试：本仓库 UI 测试跑在 node 环境（`vitest.config.ts`
 * environment: 'node'），`src/ui/package.json` 没有 jsdom / @testing-library，
 * 渲染 JSX 跑不起来。历史面板的渲染规则已经全部下沉到 `history/pure.ts`
 * （行模型、空态文案、选中项、回放/实时迁移），这里逐条固定；组件只剩取数和 JSX。
 */
import { describe, expect, it } from 'vitest';
import {
  backToLiveState,
  clockOf,
  HISTORY_LIMIT,
  historyEmptyText,
  historyRows,
  liveState,
  missState,
  REPLAY_MISS_MESSAGE,
  replayState,
  selectedIdOf,
  shouldPollLatest,
} from '../../src/ui/history/pure.js';
import type { TraceRecord } from '../../src/ui/graph/pure/trace.js';

function makeTrace(queryId: string): TraceRecord {
  return {
    schema: 'moshi-trace/1',
    query_id: queryId,
    ts: 1_793_800_000_000,
    route: 'local',
    source: 'symbolic',
    model_mode: 'off',
    model_version: null,
    seeds: ['f1'],
    results: [],
  };
}

const Q1 = 'q_01m6kde11hs4efbskn5mm3r0sr';
const Q2 = 'q_01m6kdf22hs4efbskn5mm3r0aa';

describe('clockOf（列表时间列）', () => {
  it('格式化成两位本地 HH:MM:SS', () => {
    const ts = new Date(2026, 0, 2, 9, 5, 3).getTime();
    expect(clockOf(ts)).toBe('09:05:03');
  });

  it('坏时间戳退化成「—」而不是抛错', () => {
    expect(clockOf(Number.NaN)).toBe('—');
    expect(clockOf(Number.POSITIVE_INFINITY)).toBe('—');
    expect(clockOf(0)).toBe('—');
    expect(clockOf(-1)).toBe('—');
  });
});

describe('historyRows（历史列表渲染模型）', () => {
  it('列表为空 / 未取到 / null 都映射成空数组（空态由文案函数表达）', () => {
    expect(historyRows(null)).toEqual([]);
    expect(historyRows(undefined)).toEqual([]);
    expect(historyRows([])).toEqual([]);
  });

  it('保持接口的新→旧顺序，并给出时间 / 短 id / route·source', () => {
    const ts = new Date(2026, 0, 2, 9, 5, 3).getTime();
    const rows = historyRows([
      { query_id: Q1, ts, route: 'local', source: 'symbolic' },
      { query_id: Q2, ts: ts + 60_000, route: 'global', source: 'gat' },
    ]);
    expect(rows.map((r) => r.id)).toEqual([Q1, Q2]);
    expect(rows[0]?.shortId).toBe(Q1.slice(-8));
    expect(rows[0]?.clock).toBe('09:05:03');
    expect(rows[0]?.meta).toBe('local · symbolic');
    expect(rows[1]?.meta).toBe('global · gat');
  });

  it('脏项（null / 空 query_id）被跳过，不让整个面板抛错', () => {
    const rows = historyRows([
      null as unknown as { query_id: string; ts: number; route: string; source: string },
      { query_id: '', ts: 1, route: 'local', source: 'symbolic' },
      { query_id: Q1, ts: 1, route: 'local', source: 'symbolic' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(Q1);
  });
});

describe('historyEmptyText（空态）', () => {
  it('没有行且没有错误时显示普通空态（无证据链，不报错）', () => {
    const text = historyEmptyText([], null);
    expect(text).toContain('无证据链');
    expect(text).toContain('暂无历史查询');
  });

  it('列表取数失败时显示接口不可用，但仍标注无证据链', () => {
    const text = historyEmptyText([], 'HTTP 401');
    expect(text).toContain('无证据链');
    expect(text).toContain('HTTP 401');
    expect(text).not.toContain('暂无历史查询');
  });

  it('有行时不渲染空态', () => {
    const rows = historyRows([{ query_id: Q1, ts: 1, route: 'local', source: 'symbolic' }]);
    expect(historyEmptyText(rows, null)).toBeNull();
    expect(historyEmptyText(rows, 'whatever')).toBeNull();
  });
});

describe('实时 / 回放状态迁移（不串数据）', () => {
  it('liveState：实时态不带回放 id，trace 为空时也是合法状态', () => {
    const empty = liveState(null);
    expect(empty).toEqual({ trace: null, error: null, mode: 'live', queryId: null });
    const live = liveState(makeTrace(Q1));
    expect(live.mode).toBe('live');
    expect(live.queryId).toBeNull();
    expect(live.trace?.query_id).toBe(Q1);
  });

  it('replayState：图上换成为选中的历史 trace，并记住回放 id', () => {
    const trace = makeTrace(Q2);
    const state = replayState(trace, Q2);
    expect(state.mode).toBe('replay');
    expect(state.queryId).toBe(Q2);
    expect(state.trace).toBe(trace);
    expect(state.error).toBeNull();
  });

  it('missState：404 / 淘汰降级成「无证据链」，不保留任何旧 trace', () => {
    const state = missState(Q2);
    expect(state.trace).toBeNull();
    expect(state.mode).toBe('replay');
    expect(state.queryId).toBe(Q2);
    expect(state.error).toBe(REPLAY_MISS_MESSAGE);
    expect(state.error).toContain('64');
    expect(missState(Q2, '网络断开').error).toBe('网络断开');
  });

  it('backToLiveState：回放 trace 被清掉，不会当成实时数据继续用', () => {
    const replay = replayState(makeTrace(Q2), Q2);
    const back = backToLiveState();
    expect(replay.trace).not.toBeNull();
    expect(back).toEqual({ trace: null, error: null, mode: 'live', queryId: null });
    expect(selectedIdOf(back)).toBeNull();
  });

  it('shouldPollLatest：只有实时态允许 3s 轮询覆盖，回放期间静默', () => {
    expect(shouldPollLatest(liveState(makeTrace(Q1)))).toBe(true);
    expect(shouldPollLatest(replayState(makeTrace(Q2), Q2))).toBe(false);
    expect(shouldPollLatest(missState(Q2))).toBe(false);
  });

  it('selectedIdOf：实时看图上 trace，回放看选中的历史项', () => {
    expect(selectedIdOf(liveState(makeTrace(Q1)))).toBe(Q1);
    expect(selectedIdOf(liveState(null))).toBeNull();
    expect(selectedIdOf(replayState(makeTrace(Q2), Q2))).toBe(Q2);
    // 回放的 trace 被淘汰后（trace=null）仍能高亮用户点的那一条
    expect(selectedIdOf(missState(Q2))).toBe(Q2);
  });

  it('完整切换序列 live → replay → live 不会把两条 trace 串在一起', () => {
    const t1 = makeTrace(Q1);
    const t2 = makeTrace(Q2);
    const live = liveState(t1);
    const replay = replayState(t2, Q2);
    const miss = missState(Q2);
    const back = backToLiveState();

    expect(selectedIdOf(live)).toBe(Q1);
    // 回放期间轮询静默 → 不会把 t1 顶回图上
    expect(shouldPollLatest(replay)).toBe(false);
    expect(replay.trace?.query_id).toBe(Q2);
    // 回放项被淘汰：图上无 trace，但选中态仍是 Q2（面板继续高亮、提示淘汰原因）
    expect(miss.trace).toBeNull();
    expect(selectedIdOf(miss)).toBe(Q2);
    // 回到实时：不残留 t2
    expect(back.trace).toBeNull();
    expect(selectedIdOf(back)).toBeNull();
    // 重新回到实时最新一条时只写 t1
    expect(liveState(t1).trace?.query_id).toBe(Q1);
  });
});

describe('HISTORY_LIMIT', () => {
  it('默认只列最近 20 条（后端上限 64，UI 不拉满）', () => {
    expect(HISTORY_LIMIT).toBe(20);
  });
});
