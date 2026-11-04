/**
 * `/api/status` 的运行态扩展（P2-19A-08，详设 §10.7 / 概设 §8.4 首次引导）。
 *
 * 把「模型是否就绪、后台任务最近一次跑在什么时候、MCP 宿主最近一次调用是什么工具」
 * 从各处收成一个纯读取函数，由 HTTP 层展开进 `/api/status`（只增字段，不动既有契约）。
 *
 * 纪律：
 * - **纯读**：只 SELECT meta / sidecar 状态，不写任何行；
 * - **没有写入方的字段一律 null**，不拿进程启动时间或文件 mtime 冒充（前端据此显式降级）；
 * - 不依赖 Fastify / Config，方便单测直接钉 JSON 形状。
 */
import type { SidecarStatus } from '../../infra/sidecar/client.js';
import type { Db } from '../../infra/sqlite/db.js';
import { getMeta } from '../../infra/sqlite/metaRepo.js';

/** 模型/语义检索状态：没有 sidecar 注入时 state='off'、其余为 null */
export interface StatusModel {
  state: string;
  mode: 'on' | 'off' | null;
  embed_model: string | null;
}

/**
 * 后台任务的最近时间戳（ISO 字符串）。
 *
 * `last_harvest_at` 由 P2-17 的 scheduler/harvestRunner 写入；
 * 其余三个当前**没有写入方**（consolidate / export / eval 都不写 meta），
 * 因此恒为 null，等对应任务补写后再接，不伪造。
 */
export interface StatusJobs {
  last_harvest_at: string | null;
  last_consolidate_at: string | null;
  last_export_at: string | null;
  last_eval_at: string | null;
}

/** MCP 宿主最近一次工具调用（由 `src/app/mcp/tools.ts` 的公共入口写入） */
export interface StatusMcp {
  last_call_at: string | null;
  last_call_tool: string | null;
}

export interface StatusExtras {
  model: StatusModel;
  jobs: StatusJobs;
  mcp: StatusMcp;
}

/** 只依赖 `status()`，测试可传一个假对象；daemon 直接传 `HttpDeps`（含 sidecar 时结构兼容） */
export interface StatusExtrasDeps {
  sidecar?: { status(): SidecarStatus };
}

/** meta 值为空串时按 null 处理：历史脏值不该污染 JSON 契约 */
function metaOrNull(db: Db, key: string): string | null {
  const value = getMeta(db, key);
  return value === null || value.trim() === '' ? null : value;
}

/**
 * 组装 `/api/status` 的扩展字段。
 *
 * 不传 `sidecar`（CLI / 测试 / 未装配 sidecar 的 daemon）时模型组一律 off + null，
 * 而不是把 undefined 漏进 JSON（前端三灯与首开五态都靠这个区分「没配」与「未知」）。
 */
export function buildStatusExtras(db: Db, deps: StatusExtrasDeps = {}): StatusExtras {
  const sidecar: SidecarStatus | undefined = deps.sidecar?.status();
  return {
    model:
      sidecar === undefined
        ? { state: 'off', mode: null, embed_model: null }
        : { state: sidecar.state, mode: sidecar.mode, embed_model: sidecar.embedModel },
    jobs: {
      last_harvest_at: metaOrNull(db, 'last_harvest_at'),
      last_consolidate_at: metaOrNull(db, 'last_consolidate_at'),
      last_export_at: metaOrNull(db, 'last_export_at'),
      last_eval_at: metaOrNull(db, 'last_eval_at'),
    },
    mcp: {
      last_call_at: metaOrNull(db, 'mcp.last_call_at'),
      last_call_tool: metaOrNull(db, 'mcp.last_call_tool'),
    },
  };
}
