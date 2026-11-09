/**
 * 标志位 → 哈希身份（Z-01C / 设计 §5，决策 D-174）。
 *
 * 两个 ID，都是 `sha256` 前 32 位十六进制（128 bit），**不放盐**：
 *   - `session.moshi_id`：会话级，钩子在每个轮次带着宿主会话 id 来，归一成一个稳定 id；
 *   - `project.project_id`：工程级，`scope` 与注入文本的工程标签都来自它。
 *
 * 为什么第一版放了盐又拿掉（D-174）：设备指纹做盐会把同一份记忆在不同机器上
 * 割裂成互不相关的两套，而"跨设备关联"恰恰是本系统的特色。设备只做来源记录
 * （`episode.agent`），**不进哈希输入**。
 *
 * 三条纪律：
 * 1. 输入是**白名单对象**，不是整条事件——否则钩子多带一个字段，所有人的 id 就集体漂移；
 * 2. 用 `canonicalJson`（键排序、无空白）再哈希，键序不同不得产生不同的 id；
 * 3. 返回 `null` 而不是"随便造一个"：调用方必须显式处理"没有身份"这一档。
 */
import { canonicalJson, sha256Hex } from './hash.js';

/** 哈希结果的长度（十六进制位数）。128 bit 够用且短到能进 UI。 */
export const IDENTITY_HASH_LEN = 32;

function hash32(label: string, parts: Record<string, unknown>): string {
  return sha256Hex(`${label}\n${canonicalJson(parts)}`).slice(0, IDENTITY_HASH_LEN);
}

/** 标志位来源，影响可信度判定（设计 §5.7） */
export type IdentitySource = 'vcs' | 'local' | 'unknown';

/**
 * 会话身份的输入。
 *
 * **不含 host**：同一个宿主会话如果在两个入口（比如 Magpie 与 Claude Code）被观测到，
 * 掺上 host 就会拆成两个会话，跨入口归并就再也做不到了。
 */
export interface SessionIdentityInput {
  readonly id: string;
}

/** 项目身份的输入（三档之一） */
export type ProjectIdentityInput =
  | {
      readonly kind: 'vcs';
      readonly root: string;
      /** 规范化后的 remote；无 remote 时为 null，靠 root 区分 */
      readonly remote: string | null;
    }
  | { readonly kind: 'local'; readonly root: string };

/** 会话 id → `moshi_id`；空 id 返回 null（没有身份的会话不记账） */
export function sessionMoshiId(input: SessionIdentityInput): string | null {
  const id = input.id.trim();
  if (id === '') return null;
  return hash32('moshi-session/1', { id });
}

/** 项目身份 → `project_id`；空 root 返回 null */
export function projectIdOf(input: ProjectIdentityInput): string | null {
  const root = input.root.trim();
  if (root === '') return null;
  // 只把白名单字段喂给哈希，多带的字段一律不进（见纪律 1）
  const parts =
    input.kind === 'vcs'
      ? { kind: 'vcs', root, remote: input.remote }
      : { kind: 'local', root };
  return hash32('moshi-project/1', parts);
}
