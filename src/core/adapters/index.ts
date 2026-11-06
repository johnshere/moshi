/**
 * 适配器注册表（详设 §5.2）。
 *
 * `[ingest] sources = ["claude-code"]` 里的名字到这里查。查不到**不抛错**，
 * 返回 null 并让调用方记一条 warn——配置里写错一个名字不该让 daemon 起不来，
 * 但也不能静默变成"什么都没采集"。
 */
import path from 'node:path';
import { ClaudeCodeAdapter } from './claude-code.js';
import { DEFAULT_FIELD_MAP, GenericJsonlAdapter, type FieldMap } from './generic-jsonl.js';
import type { SessionSource } from './session-source.js';

export interface SourceFactoryOptions {
  /** 覆盖 home（测试用） */
  home?: string;
  /** generic-jsonl 的根目录；app 层传 `<dataDir>/inbox` */
  genericRoot?: string;
  fieldMap?: Partial<FieldMap>;
}

export const SOURCE_NAMES = ['claude-code', 'generic-jsonl'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

/**
 * 配置解析后的会话源实例（P3-A8）。
 *
 * 旧配置 `sources = ["claude-code"]` 归一成 `{id:'claude-code', root:<home>/.claude/projects}`；
 * `[[ingest.sources]]` 允许自定义 id/root/enabled/field_map。游标 key 用 `id`，
 * 不再用适配器名——两个 claude-code 实例扫不同目录时必须互不踩游标。
 */
export interface ResolvedSource {
  id: string;
  adapter: SourceName;
  /** 已展开为绝对路径的会话根目录 */
  root: string;
  enabled: boolean;
  /** 该实例的字段映射（仅 generic-jsonl 有意义） */
  fieldMap?: Record<string, string>;
}

/** 按已解析的实例创建适配器；未知 adapter 返回 null（配置层已拦截，这里只是兜底） */
export function createSourceFor(source: ResolvedSource): SessionSource | null {
  switch (source.adapter) {
    case 'claude-code':
      return new ClaudeCodeAdapter({ root: source.root });
    case 'generic-jsonl':
      return new GenericJsonlAdapter({
        root: source.root,
        ...(source.fieldMap === undefined ? {} : { fieldMap: source.fieldMap }),
      });
    default:
      return null;
  }
}

export function createSource(name: string, opts: SourceFactoryOptions = {}): SessionSource | null {
  switch (name) {
    case 'claude-code':
      return new ClaudeCodeAdapter(opts.home === undefined ? {} : { root: claudeRoot(opts.home) });
    case 'generic-jsonl': {
      if (opts.genericRoot === undefined) return null;
      return new GenericJsonlAdapter({
        root: opts.genericRoot,
        ...(opts.fieldMap === undefined ? {} : { fieldMap: opts.fieldMap }),
      });
    }
    default:
      return null;
  }
}

export function claudeRoot(home: string): string {
  return path.join(home, '.claude', 'projects');
}

export { DEFAULT_FIELD_MAP };
export type { FieldMap };
export type { SessionSource };
