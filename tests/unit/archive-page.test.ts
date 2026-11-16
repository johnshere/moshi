/**
 * 归档页纯函数契约（P2-19A-05b）。
 *
 * 这些断言钉死页面行为里最容易回退的部分：`?slug=` 深链、三态徽标、空态、
 * 无 markdown 库的按行渲染、重建按钮/提示文案。
 */
import { describe, expect, it } from 'vitest';
import {
  archiveHref,
  detailStateFor,
  emptyTopicsHint,
  emptyStateFor,
  exportToast,
  formatProposalError,
  formatTimestamp,
  initialSelectedSlug,
  lastExportedAt,
  previewLines,
  proposalActions,
  proposedBadge,
  rebuildDisabled,
  rebuildLabel,
  shortHash,
  slugFromSearch,
  stripFrontmatter,
  type ArchiveTopicSummary,
} from '../../src/ui/archive/pure.js';

const topic = (slug: string, last_exported_at: string | null = null): Pick<ArchiveTopicSummary, 'slug' | 'last_exported_at'> => ({
  slug,
  last_exported_at,
});

describe('slug 深链', () => {
  it('从 search 读 slug：缺失/空白 → null，其它参数不受影响', () => {
    expect(slugFromSearch('')).toBeNull();
    expect(slugFromSearch('?token=t0k')).toBeNull();
    expect(slugFromSearch('?slug=')).toBeNull();
    expect(slugFromSearch('?slug=%20%20')).toBeNull();
    expect(slugFromSearch('?slug=%E5%BC%80%E5%8F%91&token=t0k')).toBe('开发');
  });

  it('archiveHref 写/删 slug 都保留 token 等其它参数', () => {
    expect(archiveHref('/ui/archive', '?token=t0k', '开发')).toBe('/ui/archive?token=t0k&slug=%E5%BC%80%E5%8F%91');
    expect(archiveHref('/ui/archive', '?token=t0k&slug=old', null)).toBe('/ui/archive?token=t0k');
    expect(archiveHref('/ui/archive', '', null)).toBe('/ui/archive');
  });

  it('initialSelectedSlug：URL 优先（即使不在列表里），否则第一项，空列表 null', () => {
    const rows = [topic('a'), topic('b')];
    expect(initialSelectedSlug(rows, '?slug=missing')).toBe('missing');
    expect(initialSelectedSlug(rows, '')).toBe('a');
    expect(initialSelectedSlug([], '')).toBeNull();
  });
});

describe('proposed 徽标三态', () => {
  it('0 自动 → 无徽标', () => {
    expect(proposedBadge({ human_edited: 0 })).toEqual({ visible: false, label: '', canHandle: false });
  });

  it('1 待合并 → 可处理', () => {
    expect(proposedBadge({ human_edited: 1 })).toEqual({ visible: true, label: '待合并', canHandle: true });
  });

  it('2 永久人工 → 有徽标但无提案可处理', () => {
    expect(proposedBadge({ human_edited: 2 })).toEqual({ visible: true, label: '永久人工', canHandle: false });
  });
});

describe('空态/时间/哈希', () => {
  it('emptyStateFor 四态', () => {
    expect(emptyStateFor({ loading: true, error: null, topicCount: 0 })).toBe('loading');
    expect(emptyStateFor({ loading: false, error: 'boom', topicCount: 0 })).toBe('error');
    expect(emptyStateFor({ loading: false, error: null, topicCount: 0 })).toBe('empty');
    expect(emptyStateFor({ loading: false, error: null, topicCount: 2 })).toBe('list');
  });

  it('空态文案说明归档条件', () => {
    expect(emptyTopicsHint()).toContain('≥8');
    expect(emptyTopicsHint()).toContain('依赖完整度');
  });

  it('lastExportedAt 取最大 ISO 时间；全空 → null', () => {
    expect(lastExportedAt([])).toBeNull();
    expect(lastExportedAt([topic('a'), topic('b', null)])).toBeNull();
    expect(
      lastExportedAt([topic('a', '2026-01-01T00:00:00.000Z'), topic('b', '2026-02-01T00:00:00.000Z')]),
    ).toBe('2026-02-01T00:00:00.000Z');
  });

  it('shortHash 前 8 位；空值 → 破折号', () => {
    expect(shortHash('abcdef0123456789')).toBe('abcdef01');
    expect(shortHash(null)).toBe('—');
    expect(shortHash('')).toBe('—');
  });

  it('formatTimestamp 无导出显示「从未导出」', () => {
    expect(formatTimestamp(null)).toBe('从未导出');
    expect(formatTimestamp('2026-02-01T00:00:00.000Z')).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('无 markdown 库的预览渲染', () => {
  it('剥掉 frontmatter，保留正文', () => {
    const md = '---\ntopic_id: 7\nslug: x\n---\n\n# 标题\n正文';
    expect(stripFrontmatter(md)).toBe('\n# 标题\n正文');
  });

  it('按行切分标题 / 列表 / 正文 / 空行', () => {
    const lines = previewLines('# 总览\n\n## 关键事实\n- 第一条\n- 第二条\n普通文本');
    expect(lines.map((l) => l.kind)).toEqual(['h1', 'blank', 'h2', 'bullet', 'bullet', 'text']);
    expect(lines[0]?.text).toBe('总览');
    expect(lines[3]?.text).toBe('第一条');
    expect(lines[5]?.text).toBe('普通文本');
  });

  it('带 frontmatter 的归档正文不会把 frontmatter 当正文渲染', () => {
    const lines = previewLines('---\ntopic_id: 7\n---\n# 标题');
    expect(lines.some((l) => l.text.includes('topic_id'))).toBe(false);
    expect(lines.find((l) => l.kind !== 'blank')).toEqual({ kind: 'h1', text: '标题' });
  });
});

describe('详情态 / 重建 / 提案文案', () => {
  it('detailStateFor：缺失与正常降级', () => {
    expect(detailStateFor(null)).toBe('idle');
    expect(detailStateFor({ markdown: null, missing: true })).toBe('file_missing');
    expect(detailStateFor({ markdown: null })).toBe('file_missing');
    expect(detailStateFor({ markdown: '# ok' })).toBe('ok');
  });

  it('重建按钮：busy 时禁用并显示「重建中…」', () => {
    expect(rebuildLabel(false)).toBe('重建归档');
    expect(rebuildLabel(true)).toBe('重建中…');
    expect(rebuildDisabled(true, false)).toBe(true);
    expect(rebuildDisabled(false, true)).toBe(true);
    expect(rebuildDisabled(false, false)).toBe(false);
  });

  it('exportToast 用响应真实字段名（written/unchanged/proposed/elapsed_ms）', () => {
    expect(
      exportToast({
        exported: 3,
        written: 2,
        unchanged: 1,
        proposed: 1,
        dir: '/tmp/archive',
        elapsed_ms: 42,
      }),
    ).toBe('重建完成：写入 2、未变 1、待合并 1（42ms）');
  });

  it('三选一动作齐全且各带后果文案', () => {
    expect(proposalActions().map((a) => a.action)).toEqual(['accept_auto', 'keep_human', 'promote_human']);
    for (const action of proposalActions()) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.consequence.length).toBeGreaterThan(0);
    }
    const promote = proposalActions().find((a) => a.action === 'promote_human')!;
    expect(promote.label).toBe('人工版转正，后续自动更新进入提案');
    expect(promote.consequence).toContain('只刷新 .proposed.md');
    expect(promote.consequence).toContain('需再次三选一');
  });

  it('formatProposalError 带 reason 时拼进括号', () => {
    expect(formatProposalError({ error: '提案不存在', reason: 'proposed_missing' })).toBe(
      '提案不存在（proposed_missing）',
    );
    expect(formatProposalError({ error: '提案不存在' })).toBe('提案不存在');
  });
});
