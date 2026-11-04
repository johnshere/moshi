/**
 * 证据链（最近一次查询的 `moshi-trace/1`）的共享状态（P2-25）。
 *
 * 为什么单独一个 store：
 * - 3D / 2D 渲染器与 HUD 都要读同一份 trace（D-89 的"单一事件源"），props 没有通路；
 * - trace 是**只读快照**，不像 `useActivity` 那样有 5 秒 TTL：证据链要一直挂在图上，
 *   直到下一次查询把 `query_id` 换掉，或 ring buffer 把它淘汰。
 *
 * 轮询放在 `refreshLatestTrace()`（每 3s 一次，只打内存接口）：查询由 MCP / CLI 在
 * 外部发起，UI 没有推送通道（D-118 不加 SSE/WebSocket），轮询是唯一能让"刚查完"
 * 出现在图上的办法。`query_id` 没变就原地不动——否则每 3 秒重建一次 trace 对象，
 * 渲染器会被无谓地 `restyleAll`，光晕/相位也跟着重置。
 */
import { create } from 'zustand';
import { fetchTrace, fetchTraceList } from '../api.js';
import type { TraceRecord } from '../graph/pure/trace.js';

export interface TraceState {
  /** 最近一次成功取到的 trace；`null` = 无证据链（空图 / daemon 重启 / 还没有查询） */
  trace: TraceRecord | null;
  /** 取数失败的原因（只用于 HUD 的弱提示；无 trace 本身不算错） */
  error: string | null;
  /** 写入整条 trace（同 id 重复写入会被渲染器订阅方忽略） */
  setTrace(trace: TraceRecord | null): void;
  /** 回到「无证据链」（列表为空时） */
  clear(): void;
}

export const useTrace = create<TraceState>()((set) => ({
  trace: null,
  error: null,
  setTrace: (trace) => set({ trace, error: null }),
  clear: () => set((prev) => (prev.trace === null && prev.error === null ? prev : { trace: null, error: null })),
}));

/**
 * 拉「最近一次查询」的 trace 写进 store。
 *
 * 静默失败：网络 / 401 / trace 已被淘汰都只写 `error`（或保持 null），绝不 throw——
 * 无证据链是合法状态，图必须照常渲染（契约第 5 条：缺 trace 不报错）。
 */
export async function refreshLatestTrace(): Promise<void> {
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
