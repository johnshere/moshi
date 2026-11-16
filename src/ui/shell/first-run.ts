/**
 * 首开五态判定纯函数（P2-19A-08，概设 §8.4 / 详设 §10.7）。
 *
 * 单独放在 .ts 里而不是组件文件里：根 tsconfig 不启用 jsx，node 侧单测
 * 只能 import 纯逻辑（`.tsx` 会报 TS6142），组件只负责取数与渲染。
 */

export type FirstRunState = 'daemon_off' | 'no_data' | 'sidecar_off' | 'collect_off' | 'ready';

/** `/api/status` 的最小读取契约（P2-19A-08 的扩展字段全部可选，便于向后兼容） */
export interface FirstRunStatus {
  daemon?: unknown;
  sidecar?: { state?: unknown; mode?: unknown };
  model?: { state?: unknown; mode?: unknown; embed_model?: unknown };
  jobs?: { last_harvest_at?: unknown };
  mcp?: { last_call_at?: unknown; last_call_tool?: unknown };
}

export interface FirstRunOptions {
  /** 单测注入时钟，避免依赖真实 now */
  now?: number;
  /** `GET /api/config` 的 collect.enabled；拿不到传 null（不据此判定） */
  collectEnabled?: boolean | null;
  /** 「MCP 未连接」的沉默阈值，默认 30 分钟（详设 §10.7） */
  mcpIdleMs?: number;
}

/** 30 分钟无 MCP 调用 = 宿主尚未接上（详设 §10.7 判定表） */
export const MCP_IDLE_MS = 30 * 60_000;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseIso(value: unknown): number | null {
  const text = asString(value);
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * sidecar 是否算「可用」：缺失、mode=off、failed/stopped 都要提示（灰条，可跳过）。
 * `starting` 视为可用：懒启动期间不闪一下灰条；`unloaded` 是空闲卸载，功能仍在。
 */
function sidecarReady(status: FirstRunStatus): boolean {
  const sidecar = status.sidecar;
  if (sidecar === undefined) return false;
  const state = asString(sidecar.state);
  const mode = asString(sidecar.mode);
  if (mode === 'off') return false;
  return state === 'ready' || state === 'unloaded' || state === 'starting';
}

function mcpFresh(status: FirstRunStatus, now: number, idleMs: number): boolean {
  const lastAt = parseIso(status.mcp?.last_call_at);
  if (lastAt === null) return false;
  // 时钟回拨（lastAt 在未来）按「刚调用过」处理，不因为时区/手动改时间长期显示黄条
  return lastAt >= now || now - lastAt <= idleMs;
}

/**
 * 首开态判定（纯函数）。
 *
 * `status === null` = `/api/status` 取数失败 → daemon 未运行；这是唯一把网络失败
 * 当语义输入的地方，其余状态都要求 daemon 先应答。
 * 优先级：daemon_off > no_data > sidecar_off > collect_off > ready。
 */
export function firstRunState(
  status: FirstRunStatus | null,
  hasData: boolean,
  options: FirstRunOptions = {},
): FirstRunState {
  if (status === null) return 'daemon_off';
  if (!hasData) return 'no_data';
  if (!sidecarReady(status)) return 'sidecar_off';
  if (options.collectEnabled === false) return 'collect_off';
  const now = options.now ?? Date.now();
  if (!mcpFresh(status, now, options.mcpIdleMs ?? MCP_IDLE_MS)) return 'collect_off';
  return 'ready';
}

import type { DictKey } from '../i18n/dict.js';

export interface BannerSpec {
  textKey: DictKey;
  hintKey: DictKey;
  tone: 'error' | 'info' | 'muted' | 'warn';
}

/**
 * 非 ready 四态的文案；组件按 tone 上色。
 *
 * 缺口是刻意的：`collect_off` 不再挂横幅（Partial），见下方注释。
 */
export const BANNERS: Partial<Record<Exclude<FirstRunState, 'ready'>, BannerSpec>> = {
  daemon_off: {
    textKey: 'firstRun.daemonOff.text',
    hintKey: 'firstRun.daemonOff.hint',
    tone: 'error',
  },
  no_data: {
    textKey: 'firstRun.noData.text',
    hintKey: 'firstRun.noData.hint',
    tone: 'info',
  },
  sidecar_off: {
    textKey: 'firstRun.sidecarOff.text',
    hintKey: 'firstRun.sidecarOff.hint',
    tone: 'muted',
  },
  // 用户 m00882：采集提醒三态暂不提示，等正式接入逻辑定稿
  // collect_off: {
  //   text: '未配置采集来源',
  //   // 用户 m01482：MCP 提示语不要了——接入引导已由首启弹窗 + 设置 › 接入 承担
  //   hint: '在 设置 › 接入 里连接 Agent，或检查 collect.enabled',
  //   tone: 'warn',
  // },
};
