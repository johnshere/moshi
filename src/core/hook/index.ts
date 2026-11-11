/**
 * `core/hook` 的统一出口（Z-01C）。
 *
 * 只导出**纯**部分：协议类型、渲染、台账、信号落库。身份识别要读文件系统与写标志
 * 文件，属于 app 层（`app/hook/projectIdentity.ts`），不从这里出。
 */
export {
  HOOK_SCHEMA,
  HOOK_STATE_SCHEMA,
  HOOK_TRACE_SCHEMA,
  HOOK_MAIL_START,
  HOOK_MAIL_END,
  HOOK_HOSTS,
  HOOK_TURNS,
  HOOK_TURN_NAMES,
  HOOK_REPORT_CODES,
  MAGPIE_CAPS,
  isHookHost,
  isHookTurn,
} from './protocol.js';
export type {
  HookHost,
  HookTurn,
  HookReportCode,
  HookCaps,
  HookBudget,
  HookIdentity,
  HookInjectMode,
  HookEnvelope,
  HookEvidence,
  HookInjection,
  HookSignalResult,
} from './protocol.js';
export {
  MAX_ITEM_CODEPOINTS,
  DEFAULT_MAX_INJECT_BYTES,
  MAX_ITEMS,
  utf8Bytes,
  truncateCodepoints,
  renderEvidenceLine,
  renderHookMail,
  appendHookMail,
  chooseInjectMode,
} from './mail.js';
export type { RenderOptions, RenderedMail } from './mail.js';
export { HookTraceStore, HOOK_TRACE_CAPACITY } from './trace.js';
export type { HookTraceItem, HookTraceSnapshot } from './trace.js';
export { TraceSink, TRACE_LEVELS, trimTrace, dateOf } from './traceSink.js';
export type { TraceLevel, TraceSinkOptions } from './traceSink.js';
export { hookRawPath, hookRawHash, captureSignal } from './capture.js';
export type { SignalOptions, SignalOutcome } from './capture.js';
