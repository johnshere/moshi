/**
 * 归档反模式检查器单测（P2-19A / 详设 §9.7）。
 *
 * 用源码字符串直接喂 `scanArchiveSource`，不依赖真实归档目录；
 * 覆盖干净样例与三类违规（回灌 / 原文出境 / 删除）以及 `check-archive-ignore` 白名单。
 */
import { describe, expect, it } from 'vitest';
import { scanArchiveSource } from '../../tools/check-archive.js';

const cleanSource = `
import { readTextFile } from './writer.js';
import { updateArchiveMetaState } from '../../infra/sqlite/archiveRepo.js';

export function refresh(db: unknown, topicId: string, file: string): string {
  const disk = readTextFile(file);
  const hash = disk === null ? null : sha256Hex(disk);
  if (hash !== null) updateArchiveMetaState(db, topicId, { contentHash: hash });
  const body = \`# 主题\\n\\n- \${fact.content}（置信 \${fact.confidence}）\`;
  return body;
}
`;

describe('scanArchiveSource', () => {
  it('干净样例：只读 .md 算 hash + 摘要引用 fact.content，不报违规', () => {
    expect(scanArchiveSource(cleanSource, 'src/core/archive/clean.ts')).toEqual([]);
  });

  it('回灌：读归档 Markdown 后写 fact 内容 → ingest', () => {
    const source = `
import { readFileSync } from 'node:fs';
export function backfill(db: unknown, file: string): void {
  const text = readFileSync(file, 'utf8');
  db.prepare('INSERT INTO fact (id, content) VALUES (?, ?)').run('fact_x', text);
}
`;
    const violations = scanArchiveSource(source, 'src/core/archive/backfill.ts');
    expect(violations.map((v) => v.rule)).toContain('ingest');
  });

  it('原文出境：引用原始来源字段写正文 → content_full', () => {
    const source = `
export function render(episode: { rawText: string }): string {
  return '## 原记录' + episode.rawText;
}
`;
    const violations = scanArchiveSource(source, 'src/core/archive/raw.ts');
    expect(violations.map((v) => v.rule)).toContain('content_full');
  });

  it('删除归档文件 → delete', () => {
    const source = `
import { rmSync } from 'node:fs';
export function cleanup(file: string): void {
  rmSync(file, { force: true });
}
`;
    const violations = scanArchiveSource(source, 'src/core/archive/cleanup.ts');
    expect(violations.map((v) => v.rule)).toContain('delete');
  });

  it('check-archive-ignore 可白名单单行', () => {
    const source = `
import { rmSync } from 'node:fs';
export function cleanup(file: string): void {
  // check-archive-ignore 合并/分裂迁移期的一次性清理
  rmSync(file, { force: true });
}
`;
    expect(scanArchiveSource(source, 'src/core/archive/cleanup.ts')).toEqual([]);
  });
});
