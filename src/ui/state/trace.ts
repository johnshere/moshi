/**
 * 证据链（`moshi-trace/1`）的共享状态：实时最新一条 + 历史回放（P2-25 / P2-26）。
 *
 * 为什么单独一个 store：
 * - 3D / 2D 渲染器与 HUD 都要读同一份 trace（D-89 的"单一事件源"），props 没有通路；
 * - trace 是**只读快照**，不像 `useActivity` 那样有 5 秒 TTL：证据链要一直挂在图上，
 *   直到下一次查询把 `query_id` 换掉，或 ring buffer 把它淘汰。
 *
 * 两种模式（P2-26 / D-118）：
 * - `live`：跟随「最近一次查询」。轮询是唯一能让外部查询（MCP / CLI）产生的 trace
 *   出现在图上的办法——D-118 明确不加 SSE/WebSocket；
 * - `replay`：图上是用户从历史列表里选中的那条 trace。回放期间轮询必须静默，
 *   否则 3 秒后就会把回放换成实时数据（"不串数据"由 `shouldPollLatest` 保证）。
 *
 * 状态迁移本身在 `history/pure.ts`（root tsconfig 可 typecheck，单测直接覆盖）；
 * 这里只负责 fetch + set，不重复写规则。
 */
import { create } from 'zustand';
import { fetchTrace, fetchTraceList } from '../api.js';
import type { TraceRecord } from '../graph/pure/trace.js';
import {
  backToLiveState,
  liveState,
  missState,
  replayState,
  shouldPollLatest,
  type TraceMode,
} from '../history/pure.js';

export interface TraceState {
  /** 当前图上的 trace；`null` = 无证据链（空图 / daemon 重启 / 回放项已被淘汰） */
  trace: TraceRecord | null;
  /** 取数失败 / 回放缺失的原因（只用于 HUD 的弱提示；无 trace 本身不算错） */
  error: string | null;
  /** `live` = 跟随最近一次查询；`replay` = 正在回放历史查询 */
  mode: TraceMode;
  /** 回放时的 query_id；实时态为 null */
  queryId: string | null;
  /** 实时态写入：最近一次查询的 trace（同 id 重复写入会被渲染器订阅方忽略） */
  setTrace(trace: TraceRecord | null): void;
  /** 进入回放态 */
  replay(trace: TraceRecord, queryId: string): void;
  /** 回放取数失败 → 「无证据链」降级（不抛错） */
  miss(queryId: string, message?: string): void;
  /** 回到实时态（清空回放 trace，由调用方立刻补拉最新一条） */
  backToLive(): void;
  /** 回到「无证据链」（列表为空时） */
  clear(): void;
}

export const useTrace = create<TraceState>()((set) => ({
  ...liveState(null),
  setTrace: (trace) => set(liveState(trace)),
  replay: (trace, queryId) => set(replayState(trace, queryId)),
  miss: (queryId, message) => set(missState(queryId, message)),
  backToLive: () => set(backToLiveState()),
  clear: () => set(liveState(null)),
}));

/**
 * 拉「最近一次查询」的 trace 写进 store。
 *
 * 回放期间直接返回：用户选中的历史 trace 不能被 3s 轮询顶掉（P2-26 核心规则）。
 * 静默失败：网络 / 401 / trace 已被淘汰都只写 `error`（或保持 null），绝不 throw——
 * 无证据链是合法状态，图必须照常渲染（契约：缺 trace 不报错）。
 */
export async function refreshLatestTrace(): Promise<void> {
  if (!shouldPollLatest(useTrace.getState())) return;
  try {
    const list = await fetchTraceList(1);
    const latest = list.queries[0];
    if (latest === undefined) {
      useTrace.getState().clear();
      return;
    }
    if (useTrace.getState().trace?.query_id === latest.query_id) return;
    const record = await fetchTrace(latest.query_id);
    useTrace.getState().setTrace(record);
  } catch (err) {
    useTrace.setState({ error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * 回放一条历史查询：`GET /api/trace/:query_id`。
 *
 * 404（`fetchTrace` 返回 null）= 该 trace 已被 ring buffer 淘汰或 daemon 重启过，
 * 属于正常降级：清成「无证据链」并保留一行提示，不抛错。
 */
export async function replayTrace(queryId: string): Promise<void> {
  try {
    const record = await fetchTrace(queryId);
    if (record === null) {
      useTrace.getState().miss(queryId);
      return;
    }
    // 以服务端 trace 里的 query_id 为准（回退到入参，防御脏数据）
    useTrace.getState().replay(record, record.query_id === undefined ? queryId : record.query_id);
  } catch (err) {
    useTrace.getState().miss(queryId, err instanceof Error ? err.message : String(err));
  }
}

/** 退出回放、回到实时：先清空回放态，再立刻补拉「最近一次查询」 */
export async function backToLiveTrace(): Promise<void> {
  useTrace.getState().backToLive();
  await refreshLatestTrace();
}
