/**
 * schema 校验与迁移 diff 的纯函数层（详设 §2.6 / §8.5；台账 P2-14）。
 *
 * 分工：
 *
 * - **校验**：写入前拿 `attrs` 对照 `ontology` 里**已登记**（promoted=1）的
 *   predicate / attr_key 定义，只约束已登记键；未登记键**放行**，但要把键名
 *   交回调用方（落进 ontology 的 `promoted=0` 行，作为待晋升线索）。
 *   已登记键类型不符（或草稿显式声明的基数性与登记值冲突）→ `E_SCHEMA`。
 * - **快照 / diff**：把 ontology 的已登记定义导出成 JSON 快照；对比晋升前后的
 *   两个快照得到 added / removed / changed 三类差异，并渲染迁移脚本**草稿**
 *   （只生成 SQL 文本，绝不执行 DDL）。
 *
 * 本文件不碰 db、不碰 fs：db 读写收在 `infra/sqlite/ontologyRepo.ts`，
 * 命令行入口收在 `app/cli/commands/schema.ts`。
 *
 * 为什么单个事实的基数性不单独判：基数性是**谓词级**约束，由冲突策略按
 * 同身份键的多条事实判定，单条 attrs 无法自证；这里只在调用方显式带着
 * 与登记值不同的 cardinality 草稿时拦（通常意味着调用方版本旧）。
 */
import { MoshiError } from '../../domain/errors.js';
import type { Cardinality } from '../../domain/enums.js';
import { canonicalJson } from '../../domain/hash.js';
import type { FactAttrs } from '../../domain/types.js';

/** `ontology.value_type` 的词汇表（migrations/001_init.sql 的注释即权威） */
export const SCHEMA_VALUE_TYPES = ['string', 'number', 'bool', 'time', 'enum', 'json'] as const;
export type SchemaValueType = (typeof SCHEMA_VALUE_TYPES)[number];

export type SchemaKeyKind = 'predicate' | 'attr_key';

/** 已登记键的定义（只取校验需要的字段；`promoted=1` 的行才进这里） */
export interface RegisteredKeyDef {
  kind: SchemaKeyKind;
  name: string;
  /** null = 只登记了基数性/未定类型，不做类型校验 */
  valueType: string | null;
  cardinality: Cardinality | null;
}

export interface SchemaViolation {
  /** 形如 `predicate:installed_version` / `attr_key:channel` / `frozen` */
  key: string;
  expected: string;
  actual: string;
}

export interface AttrsValidation {
  ok: boolean;
  errors: SchemaViolation[];
  /** 未登记的键，形如 `predicate:xxx` / `attr_key:yyy`；已排序去重 */
  unregisteredKeys: string[];
}

export interface ValidateAttrsOptions {
  /** 草稿显式声明的基数性；与登记值不一致即视为调用方版本旧 */
  declaredCardinality?: Cardinality | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 从取值猜 `ontology.value_type`（只用于待晋升登记，推断不出 time/enum） */
export function inferSchemaValueType(value: unknown): SchemaValueType {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'bool';
  return 'json';
}

/** 给错误详情用的实际类型标签（不是 JSON Schema 类型，只是可读） */
export function describeSchemaValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? 'number' : 'non-finite number';
  if (t === 'object') return 'object';
  return t;
}

/** 单个值是否符合登记的类型；未知类型名不拦（登记表被手改坏时宁可放行不误伤） */
export function matchesSchemaValueType(value: unknown, valueType: string): boolean {
  switch (valueType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'time':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'enum':
      return typeof value === 'string' || typeof value === 'number';
    case 'json':
      try {
        canonicalJson(value);
        return true;
      } catch {
        return false;
      }
    default:
      return true;
  }
}

/** 用草稿拼一份「校验用 attrs」：entity_id 尚未消解，给占位值即可 */
export function attrsFromDraft(draft: {
  subject?: string;
  predicate: string;
  value: unknown;
  ext?: Record<string, unknown>;
}): FactAttrs {
  return {
    frozen: {
      subject: { entity_id: '', name: draft.subject ?? '' },
      predicate: draft.predicate,
      value: draft.value,
    },
    ext: draft.ext ?? {},
  };
}

/**
 * 校验一条 attrs。纯函数：不写库、不抛异常（结构性问题记成 error 而不是 throw）。
 *
 * 校验范围：
 * - `frozen` 结构必须恰好是 subject / predicate / value 三个键（详设 §2.10）；
 * - 已登记 predicate 的取值类型、调用方显式声明的基数性；
 * - 已登记 attr_key 的取值类型；
 * - 未登记 predicate / attr_key 放行，键名进 `unregisteredKeys`。
 */
export function validateAttrs(
  attrs: FactAttrs,
  defs: readonly RegisteredKeyDef[],
  opts: ValidateAttrsOptions = {},
): AttrsValidation {
  const errors: SchemaViolation[] = [];
  const unregistered = new Set<string>();
  const defsByKey = new Map<string, RegisteredKeyDef>();
  for (const def of defs) defsByKey.set(`${def.kind}\u0000${def.name}`, def);

  const frozen = (attrs as { frozen?: unknown }).frozen;
  if (!isRecord(frozen)) {
    errors.push({ key: 'frozen', expected: 'subject,predicate,value', actual: '(missing)' });
  } else {
    const keys = Object.keys(frozen).sort();
    const expectedKeys = ['predicate', 'subject', 'value'];
    if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
      errors.push({
        key: 'frozen',
        expected: 'subject,predicate,value',
        actual: keys.length === 0 ? '(empty)' : keys.join(','),
      });
    }

    const predicate = frozen['predicate'];
    if (typeof predicate === 'string' && predicate.length > 0) {
      const def = defsByKey.get(`predicate\u0000${predicate}`);
      if (def === undefined) {
        unregistered.add(`predicate:${predicate}`);
      } else {
        const value = frozen['value'];
        if (def.valueType !== null && !matchesSchemaValueType(value, def.valueType)) {
          errors.push({
            key: `predicate:${predicate}`,
            expected: def.valueType,
            actual: describeSchemaValue(value),
          });
        }
        const declared = opts.declaredCardinality;
        if (
          def.cardinality !== null &&
          declared !== undefined &&
          declared !== null &&
          declared !== def.cardinality
        ) {
          errors.push({
            key: `predicate:${predicate}`,
            expected: `cardinality=${def.cardinality}`,
            actual: `cardinality=${declared}`,
          });
        }
      }
    } else {
      errors.push({
        key: 'frozen.predicate',
        expected: 'non-empty string',
        actual: describeSchemaValue(predicate),
      });
    }
  }

  const ext = (attrs as { ext?: unknown }).ext;
  if (ext !== undefined && ext !== null) {
    if (!isRecord(ext)) {
      errors.push({ key: 'ext', expected: 'object', actual: describeSchemaValue(ext) });
    } else {
      for (const key of Object.keys(ext).sort()) {
        const value = ext[key];
        const def = defsByKey.get(`attr_key\u0000${key}`);
        if (def === undefined) {
          unregistered.add(`attr_key:${key}`);
          continue;
        }
        if (def.valueType !== null && !matchesSchemaValueType(value, def.valueType)) {
          errors.push({
            key: `attr_key:${key}`,
            expected: def.valueType,
            actual: describeSchemaValue(value),
          });
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    unregisteredKeys: [...unregistered].sort(),
  };
}

/** 校验失败即抛 `E_SCHEMA`（写通路用）；通过则原样返回结果（含未登记键） */
export function assertAttrsValid(
  attrs: FactAttrs,
  defs: readonly RegisteredKeyDef[],
  opts: ValidateAttrsOptions = {},
): AttrsValidation {
  const result = validateAttrs(attrs, defs, opts);
  if (result.ok) return result;
  const detail = result.errors.map((e) => `${e.key} 期望 ${e.expected}，实际 ${e.actual}`).join('；');
  throw new MoshiError('E_SCHEMA', `attrs 违反已登记 schema：${detail}`, {
    errors: result.errors,
    unregistered_keys: result.unregisteredKeys,
  });
}

export interface DraftLike {
  subject?: string;
  predicate: string;
  value: unknown;
  ext?: Record<string, unknown>;
  cardinality?: Cardinality | null;
}

/** 草稿级校验（harvest / 直写共用）：entity_id 未消解也能校验 frozen 之外的约束 */
export function validateDraft(draft: DraftLike, defs: readonly RegisteredKeyDef[]): AttrsValidation {
  return validateAttrs(attrsFromDraft(draft), defs, {
    ...(draft.cardinality === undefined || draft.cardinality === null
      ? {}
      : { declaredCardinality: draft.cardinality }),
  });
}

export interface PendingKeyEntry {
  kind: SchemaKeyKind;
  name: string;
  valueType: SchemaValueType;
}

/** 把 `unregisteredKeys` 翻译成待晋升登记项（供 ontology 表 promoted=0 行） */
export function pendingEntries(
  attrs: FactAttrs,
  unregisteredKeys: readonly string[],
): PendingKeyEntry[] {
  const out: PendingKeyEntry[] = [];
  for (const key of unregisteredKeys) {
    const sep = key.indexOf(':');
    if (sep <= 0) continue;
    const kind = key.slice(0, sep);
    const name = key.slice(sep + 1);
    if (name.length === 0) continue;
    if (kind === 'predicate') {
      out.push({
        kind,
        name,
        valueType: inferSchemaValueType((attrs.frozen as { value?: unknown }).value),
      });
    } else if (kind === 'attr_key') {
      out.push({ kind, name, valueType: inferSchemaValueType((attrs.ext ?? {})[name]) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 快照 / diff

export const SCHEMA_SNAPSHOT_VERSION = 'moshi-schema/1';

export interface SchemaSnapshotEntry {
  kind: SchemaKeyKind;
  name: string;
  valueType: string | null;
  cardinality: Cardinality | null;
}

export interface SchemaSnapshot {
  schema: typeof SCHEMA_SNAPSHOT_VERSION;
  generatedAt: string;
  entries: SchemaSnapshotEntry[];
}

const KIND_ORDER: Record<SchemaKeyKind, number> = { attr_key: 0, predicate: 1 };

function compareEntries(a: SchemaSnapshotEntry, b: SchemaSnapshotEntry): number {
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function entryKey(entry: { kind: SchemaKeyKind; name: string }): string {
  return `${entry.kind}\u0000${entry.name}`;
}

/** 生成快照：条目按 kind（attr_key 在前）+ name 排序，保证输出确定 */
export function buildSchemaSnapshot(
  entries: readonly SchemaSnapshotEntry[],
  generatedAt: string,
): SchemaSnapshot {
  const sorted = [...entries]
    .map((e) => ({
      kind: e.kind,
      name: e.name,
      valueType: e.valueType,
      cardinality: e.cardinality,
    }))
    .sort(compareEntries);
  return { schema: SCHEMA_SNAPSHOT_VERSION, generatedAt, entries: sorted };
}

/** 解析并规范化快照文件内容；格式错误抛 `E_INPUT` */
export function parseSchemaSnapshot(text: string): SchemaSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MoshiError('E_INPUT', 'schema 快照不是合法 JSON', {
      expected: SCHEMA_SNAPSHOT_VERSION,
    });
  }
  if (!isRecord(raw) || raw['schema'] !== SCHEMA_SNAPSHOT_VERSION || !Array.isArray(raw['entries'])) {
    throw new MoshiError(
      'E_INPUT',
      `schema 快照格式不符：需要 { "schema": "${SCHEMA_SNAPSHOT_VERSION}", "entries": [...] }`,
      { expected: SCHEMA_SNAPSHOT_VERSION },
    );
  }
  const entries: SchemaSnapshotEntry[] = [];
  for (const item of raw['entries']) {
    if (!isRecord(item)) {
      throw new MoshiError('E_INPUT', 'schema 快照条目不是对象', { entry: item });
    }
    const kind = item['kind'];
    const name = item['name'];
    if ((kind !== 'predicate' && kind !== 'attr_key') || typeof name !== 'string' || name.length === 0) {
      throw new MoshiError('E_INPUT', 'schema 快照条目缺少合法的 kind/name', { entry: item });
    }
    const valueType = item['valueType'] ?? null;
    if (valueType !== null && typeof valueType !== 'string') {
      throw new MoshiError('E_INPUT', 'schema 快照条目 valueType 必须是字符串或 null', {
        entry: item,
      });
    }
    const cardinality = item['cardinality'] ?? null;
    if (
      cardinality !== null &&
      cardinality !== 'single-valued' &&
      cardinality !== 'series' &&
      cardinality !== 'set'
    ) {
      throw new MoshiError('E_INPUT', 'schema 快照条目 cardinality 非法', { entry: item });
    }
    entries.push({ kind, name, valueType, cardinality });
  }
  const generatedAt = typeof raw['generatedAt'] === 'string' ? raw['generatedAt'] : '';
  return buildSchemaSnapshot(entries, generatedAt);
}

export type SchemaField = 'value_type' | 'cardinality';

export interface SchemaChange {
  kind: SchemaKeyKind;
  name: string;
  field: SchemaField;
  before: string | null;
  after: string | null;
}

export interface SchemaDiff {
  added: SchemaSnapshotEntry[];
  removed: SchemaSnapshotEntry[];
  changed: SchemaChange[];
  unchanged: number;
  from: string;
  to: string;
}

/** 对比两个快照；added/removed/changed 各自有序，便于断言与渲染 */
export function diffSchemaSnapshots(before: SchemaSnapshot, after: SchemaSnapshot): SchemaDiff {
  const beforeMap = new Map(before.entries.map((e) => [entryKey(e), e]));
  const afterMap = new Map(after.entries.map((e) => [entryKey(e), e]));

  const added = after.entries.filter((e) => !beforeMap.has(entryKey(e))).sort(compareEntries);
  const removed = before.entries.filter((e) => !afterMap.has(entryKey(e))).sort(compareEntries);

  const changed: SchemaChange[] = [];
  let unchanged = 0;
  for (const entry of after.entries) {
    const prev = beforeMap.get(entryKey(entry));
    if (prev === undefined) continue;
    let same = true;
    if (prev.valueType !== entry.valueType) {
      same = false;
      changed.push({
        kind: entry.kind,
        name: entry.name,
        field: 'value_type',
        before: prev.valueType,
        after: entry.valueType,
      });
    }
    if (prev.cardinality !== entry.cardinality) {
      same = false;
      changed.push({
        kind: entry.kind,
        name: entry.name,
        field: 'cardinality',
        before: prev.cardinality,
        after: entry.cardinality,
      });
    }
    if (same) unchanged += 1;
  }
  changed.sort((a, b) => {
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.field < b.field ? -1 : a.field > b.field ? 1 : 0;
  });

  return { added, removed, changed, unchanged, from: before.generatedAt, to: after.generatedAt };
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlLiteral(value: string | null): string {
  return value === null ? 'NULL' : sqlText(value);
}

/**
 * 渲染迁移脚本**草稿**。调用方只负责打印/落盘，绝不在本模块执行 SQL。
 * 空 diff 也返回带说明的注释文本，方便输出到 --out 留痕。
 */
export function renderSchemaMigration(diff: SchemaDiff, generatedAt: string): string {
  const lines: string[] = [
    '-- 默识 schema 迁移脚本草稿（由 `moshi schema diff` 生成，未执行）',
    `-- generated_at: ${generatedAt}`,
    `-- 新增登记：${diff.added.length}；变更登记：${diff.changed.length}；删除登记：${diff.removed.length}`,
  ];

  if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0) {
    lines.push('-- 两个快照无差异');
    return `${lines.join('\n')}\n`;
  }

  if (diff.added.length > 0) {
    lines.push('', '-- 新增登记');
    for (const entry of diff.added) {
      lines.push(
        'INSERT INTO ontology (kind, name, value_type, cardinality, sample_count, distinct_values, single_ratio, registered_at, promoted)',
        `VALUES (${sqlText(entry.kind)}, ${sqlText(entry.name)}, ${sqlLiteral(entry.valueType)}, ${sqlLiteral(entry.cardinality)}, 0, 0, NULL, ${sqlText(generatedAt)}, 1)`,
        'ON CONFLICT(kind, name) DO UPDATE SET value_type = excluded.value_type, cardinality = excluded.cardinality, promoted = 1;',
      );
    }
  }

  if (diff.changed.length > 0) {
    lines.push('', '-- 变更登记');
    for (const change of diff.changed) {
      lines.push(
        `UPDATE ontology SET ${change.field} = ${sqlLiteral(change.after)} WHERE kind = ${sqlText(change.kind)} AND name = ${sqlText(change.name)};`,
      );
    }
  }

  if (diff.removed.length > 0) {
    lines.push('', '-- 删除登记（确认没有事实仍引用该键后再执行）');
    for (const entry of diff.removed) {
      lines.push(
        `DELETE FROM ontology WHERE kind = ${sqlText(entry.kind)} AND name = ${sqlText(entry.name)};`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}
