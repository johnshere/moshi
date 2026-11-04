/**
 * 归档写盘判定（详设 §9.4 L2815-2841；台账 P2-15）。
 *
 * 纯函数：只吃 hash / 三态 / revision，不碰磁盘与 DB，便于单测穷举分支。
 * 真正的落盘与记账在 `writer.ts`；本模块只回答「这一篇该写、跳过，还是写待决版」。
 *
 * 判定顺序（顺序即优先级，勿调换）：
 *   1. human_edited=2 → 永久人工，永不自动写、也不生成 .proposed
 *   2. 主文件不存在 → 自动写（新主题 / 用户删了文件；清三态）
 *   3. human_edited=1 → 已有待决提案，刷新 .proposed 即可，主文件与基线都不动
 *   4. 主文件存在但无基线 hash → 保守当人工文件，写 .proposed（不覆盖）
 *   5. 磁盘正文 hash !== 基线 → 检测到人工改动，写 .proposed（不覆盖，revision 不变）
 *   6. 磁盘 === 基线：目标 hash 也相同 → 跳过（保留 mtime）；不同 → 自动写，revision+1
 */
import type { HumanEdited } from '../../infra/sqlite/archiveRepo.js';

export type ArchiveWriteAction = 'write' | 'skip' | 'propose';

export interface ArchiveGuardInput {
  /** 本次渲染出的正文 hash（不含 frontmatter / 本次更新段） */
  targetHash: string;
  /** 磁盘主文件正文 hash；文件不存在 = null */
  diskHash: string | null;
  /** archive_meta.content_hash（上次自动导出的基线）；无记录 = null */
  metaHash: string | null;
  humanEdited: HumanEdited;
  /** 当前 archive_meta.revision */
  revision: number;
}

export interface ArchiveGuardDecision {
  action: ArchiveWriteAction;
  /** 判定后的三态（propose 一律升为 1；write 清为 0；skip 保持） */
  humanEdited: HumanEdited;
  /** 判定后的 revision；只有 write 自增，propose/skip 不变 */
  revision: number;
  /** 命中分支，写日志 / 单测断言用 */
  reason:
    | 'permanent_human'
    | 'missing_file'
    | 'pending_proposal'
    | 'no_baseline'
    | 'disk_mismatch'
    | 'unchanged'
    | 'changed';
}

export function decideArchiveWrite(input: ArchiveGuardInput): ArchiveGuardDecision {
  // 1. 永久人工：任何自动导出都不得碰，连 .proposed 也不再生成（human_edited=2 的出路只有显式 promote/accept）
  if (input.humanEdited === 2) {
    return { action: 'skip', humanEdited: 2, revision: input.revision, reason: 'permanent_human' };
  }

  // 2. 主文件不存在：自动写（首次导出，或用户删掉了文件）
  if (input.diskHash === null) {
    return { action: 'write', humanEdited: 0, revision: input.revision + 1, reason: 'missing_file' };
  }

  // 3. 已有人工改动等待三选一：只刷新 .proposed，主文件与基线都不动（出路只有显式 accept/promote）
  if (input.humanEdited === 1) {
    return { action: 'propose', humanEdited: 1, revision: input.revision, reason: 'pending_proposal' };
  }

  // 4. 文件在、但 archive_meta 没有基线（例如手工放进归档目录的文件）：保守当人工，不覆盖
  if (input.metaHash === null) {
    return { action: 'propose', humanEdited: 1, revision: input.revision, reason: 'no_baseline' };
  }

  // 5. 磁盘正文与基线不一致 → 人工改过；写 .proposed.md 等待三选一，主文件不动、revision 不变
  if (input.diskHash !== input.metaHash) {
    return { action: 'propose', humanEdited: 1, revision: input.revision, reason: 'disk_mismatch' };
  }

  // 6. 磁盘 === 基线：内容确实没变就不写盘（保 mtime）；变了才自动写
  if (input.targetHash === input.metaHash) {
    return { action: 'skip', humanEdited: 0, revision: input.revision, reason: 'unchanged' };
  }
  return { action: 'write', humanEdited: 0, revision: input.revision + 1, reason: 'changed' };
}
