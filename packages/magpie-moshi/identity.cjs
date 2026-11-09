/**
 * 身份哈希的本机实现（Z-01C / 设计 §5，决策 D-174）。
 *
 * 为什么这里要**第五份**实现（TypeScript 的 `src/domain/identity.ts` 已经有四份口径）：
 *
 * Magpie 的 plugin-host 会直接 import 本文件，它跑在宿主的进程里，**加载不到 moshi
 * 的 dist**，也不能再装一个依赖。所以 `moshi-hook/1` 的"标志位 → 哈希"必须有一份
 * 零依赖的可复制实现。它只保证一件事：**输入相同时，输出与 daemon 逐字节一致**。
 *
 * 一致性靠测试钉住（`tests/unit/hook-package.test.ts` 拿 `domain/identity.ts` 的
 * 真实输出对照），不靠"我记得两边一样"。
 */
'use strict';

/** 与 daemon 侧 `IDENTITY_HASH_LEN` 一致 */
const IDENTITY_HASH_LEN = 32;

/**
 * 规范化 JSON：对象键**排序**、无空白、数组保序。
 *
 * 必须与 `src/domain/hash.ts` 的 `canonicalJson` 逐字节一致——那边是
 * `JSON.stringify` 加键排序，数字/字符串/布尔/null 的序列化规则相同。
 * 这里不处理 undefined（调用方的输入是白名单对象，不会有）。
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) parts.push(JSON.stringify(k) + ':' + canonicalJson(value[k]));
  return '{' + parts.join(',') + '}';
}

function hash32(label, parts) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('node:crypto');
    return createHash('sha256')
      .update(`${label}\n${canonicalJson(parts)}`, 'utf8')
      .digest('hex')
      .slice(0, IDENTITY_HASH_LEN);
  } catch {
    return null;
  }
}

/** 会话 id → `moshi_id`；空 id 返回 null（与 daemon 侧同口径） */
function sessionMoshiId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (trimmed === '') return null;
  return hash32('moshi-session/1', { id: trimmed });
}

/**
 * 工程身份 → `project_id`。`input` 形状与 `domain/identity.ts` 的
 * `ProjectIdentityInput` 完全一致：
 *   { kind: 'vcs', root, remote } | { kind: 'local', root }
 */
function projectIdOf(input) {
  if (!input || typeof input !== 'object') return null;
  const root = typeof input.root === 'string' ? input.root.trim() : '';
  if (root === '') return null;
  const parts =
    input.kind === 'vcs'
      ? { kind: 'vcs', root: root, remote: input.remote === undefined ? null : input.remote }
      : { kind: 'local', root: root };
  return hash32('moshi-project/1', parts);
}

module.exports = { canonicalJson, sessionMoshiId, projectIdOf, IDENTITY_HASH_LEN };
