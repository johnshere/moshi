/**
 * 钩子写入侧：`/hook/signal` 落 episode + annotation（Z-01C / 设计 §6）。
 *
 * 这一层**只做形状转换**：把协议信封变成 `RawEvent`，交给既有的
 * `core/write/ingest.ts`。为什么不自己做 INSERT：
 *
 * - `episode` 的去重口径是「`raw_hash` + `session` 先查后插」，重写一遍必然漂移；
 * - 脱敏必须**先于落盘**（Z-01A 验收项），既有管线已经在 `ingestEvent` 之前跑
 *   同一条 `redactText`，钩子自己再实现一份就是两条脱敏规则；
 * - `annotation` 的 `dedup_key` / `channel` / `origin` 与文件适配器同一口径，
 *   harvest 才认得出"这是工具回合"。
 *
 * 钩子进程内**不做模型调用、不触发 harvest**（用户 R5：钩子只投递信号）。
 */
import { redactText } from '../write/redact.js';
import { ingestEvent, type IngestResult } from '../write/ingest.js';
import type { RawEvent } from '../adapters/session-source.js';
import type { Db } from '../../infra/sqlite/db.js';
import { sha256Hex } from '../../domain/hash.js';
import type { HookEnvelope, HookTurn } from './protocol.js';

/**
 * 信号来源 URI，落在 `episode.raw_path`（设计 §6.4，**不新增迁移**）。
 *
 * `moshi-hook://` 的 scheme 用来区分"这不是文件"：UI 溯源与导出按 `//` 判断，
 * 不必给 `episode` 加列。格式里带 `moshi_id` 与轮次，方便按会话 grep 日志。
 */
export function hookRawPath(host: string, moshiId: string | null, turn: HookTurn): string {
  return `moshi-hook://${host}/${moshiId ?? 'unknown'}/${turn}`;
}

/**
 * 幂等键（设计 §6.3）。
 *
 * 与文件适配器同一口径：`sha256(规范化事件源)`。**不含时间戳**——Magpie 重试
 * 同一个 prompt 时 ts 会变，掺进去就让"重试"变成了"两条新事件"。
 */
export function hookRawHash(
  host: string,
  session: string | null,
  turn: HookTurn,
  role: string,
  text: string,
): string {
  return sha256Hex(`${host}|${session ?? '-'}|${turn}|${role}|${text}`);
}

export interface SignalOptions {
  /** 脱敏开关（`cfg.redact`）；默认开，与主链路一致 */
  redact: { enabled: boolean; privateIp: boolean };
  /** 命中的工程根（写 `episode.cwd`）；unknown 档为 null */
  projectRoot: string | null;
}

export interface SignalOutcome {
  captured: boolean;
  reason?: string;
  result: IngestResult | null;
  turn: HookTurn;
  rawPath: string;
}

/** 该轮次该不该落库、落成什么角色 */
function plan(envelope: HookEnvelope): { role: 'user' | 'assistant'; text: string } | null {
  const p = envelope.payload;
  if (envelope.turn === 'response') {
    const reply = (p.reply ?? p.text ?? '').trim();
    return reply === '' ? null : { role: 'assistant', text: reply };
  }
  if (envelope.turn === 'user_prompt') {
    const text = (p.text ?? '').trim();
    return text === '' ? null : { role: 'user', text };
  }
  // post_tool / stop / session_* 在 Magpie 上不兑现；即便别的入口发来，
  // 本轮也只按文本落库（工具输出的体积控制另有开关，见设计 §10）
  const text = (p.reply ?? p.text ?? '').trim();
  if (text === '') return null;
  return { role: 'assistant', text };
}

/**
 * 落一条信号。返回 `captured=false` 表示**什么都没写**（空正文 / 开关关掉），
 * 调用方要如实把原因回给入口，而不是报 `ready`。
 */
export function captureSignal(db: Db, envelope: HookEnvelope, options: SignalOptions): SignalOutcome {
  const rawPath = hookRawPath(envelope.host, envelope.identity.moshi_id, envelope.turn);
  const planned = plan(envelope);
  if (planned === null) {
    return {
      captured: false,
      reason: 'payload 为空：没有可落库的正文',
      result: null,
      turn: envelope.turn,
      rawPath,
    };
  }

  // 脱敏先于落盘（Z-01A 验收项）：钩子侧不自己实现规则，复用同一条 redactText
  const redacted = redactText(planned.text, {
    enabled: options.redact.enabled,
    privateIp: options.redact.privateIp,
  });
  const text = redacted.text;
  if (text.trim() === '') {
    return {
      captured: false,
      reason: '脱敏后正文为空',
      result: null,
      turn: envelope.turn,
      rawPath,
    };
  }

  const session = envelope.identity.moshi_id;
  const event: RawEvent = {
    ts: envelope.ts,
    // 没有会话身份时落一个**稳定**的占位符而不是空串：episode 的唯一性靠
    // (raw_hash, session)，空串会让所有无会话信号挤进同一个桶里互相去重
    sessionId: session ?? `${envelope.host}:anonymous`,
    cwd: options.projectRoot,
    agent: envelope.host,
    rawHash: hookRawHash(envelope.host, session, envelope.turn, planned.role, text),
    rawPath,
    role: planned.role,
    text,
  };

  const result = ingestEvent(db, event);
  return { captured: true, result, turn: envelope.turn, rawPath };
}
