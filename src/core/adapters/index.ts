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
