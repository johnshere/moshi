/**
 * 召回页的纯函数（不碰 DOM、不 import React），单测可直接钉边界。
 *
 * 为什么单独一层：`confidence_summary === 'none'` ↔ 「无可靠记忆」的映射是契约理解，
 * 不是样式细节；写在 JSX 里的三元没法被 `tests/unit` 直接验证，也容易被下一次改动
 * 顺手改成「空即报错」——那正是 P2① 要消除的误解。
 */
import type { DictKey } from '../i18n/dict.js';
import type { RecallPayload } from './api.js';
/** 置信度档 → 文案 key（未知档按 none 处理：宁可说「无」，不可假装有） */
export function confidenceKey(level: RecallPayload['confidence_summary'] | string): DictKey {
  switch (level) {
    case 'high':
      return 'recall.confidence.high';
    case 'medium':
      return 'recall.confidence.medium';
    case 'low':
      return 'recall.confidence.low';
    default:
      return 'recall.confidence.none';
  }
}

/** 降级码去重 + 稳定排序：同一通道降级多次只显示一次（截图可比对） */
export function degradedCodes(codes: readonly string[]): string[] {
  return [...new Set(codes)].sort();
}

/**
 * 空命中只看包本身：`evidence` 为空即「无可靠记忆」。
 *
 * 不依赖 HTTP 状态码，也不依赖 `status`（空包时 status 仍是 'ok'，见
 * `core/read/evidence.ts`）——把「空」当错误是本任务要修掉的旧习惯。
 */
export function isEmptyHit(pack: { evidence: readonly unknown[] }): boolean {
  return pack.evidence.length === 0;
}
