/**
 * 设置页隐私面板纯函数测试（P2-19A-15）。
 *
 * 只测 `src/ui/settings/privacy-pure.ts`：判定与展示口径（不测 React 渲染，仓库无 jsdom）。
 */
import { describe, expect, it } from 'vitest';
import {
  canSubmitPurge,
  evalRunText,
  formatBytes,
  overviewRows,
  purgeDeletedTotal,
  purgeSummary,
  purgeScopes,
  type PrivacyOverview,
  type WouldDelete,
} from '../../src/ui/settings/privacy-pure.js';

function makeOverview(overrides: Partial<PrivacyOverview> = {}): PrivacyOverview {
  return {
    schema: 'moshi-privacy/1',
    db: { path: '/home/u/.moshi/moshi.db', size_mb: 12.5, wal_mb: 0.25 },
    counts: {
      facts: 120,
      edges: 60,
      entities: 18,
      annotations: 7,
      sessions: 3,
      archive_topics: 4,
      facts_pruned: 2,
      facts_invalidated: 5,
    },
    archive: { dir: '/home/u/Documents/默识归档', topics: 4, bytes: 2048 },
    retention: { prune_idle_days: 60, half_life_days: 14 },
    last_purge_at: null,
    ...overrides,
  };
}

const wouldDelete: WouldDelete = {
  facts: 1,
  edges: 2,
  entities: 3,
  annotations: 4,
  sessions: 5,
  archive_files: 6,
};

describe('canSubmitPurge', () => {
  it('只接受逐字 PURGE（允许首尾空白），并校验 scope 合法', () => {
    expect(canSubmitPurge('PURGE', 'all')).toBe(true);
    expect(canSubmitPurge('  PURGE  ', 'facts')).toBe(true);
    expect(canSubmitPurge('purge', 'all')).toBe(false);
    expect(canSubmitPurge('PURG', 'all')).toBe(false);
    expect(canSubmitPurge('', 'all')).toBe(false);
    expect(canSubmitPurge('PURGE', 'bogus' as never)).toBe(false);
  });

  it('四个 scope 都有中文标签且值唯一', () => {
    expect(purgeScopes().map((s) => s.value)).toEqual(['all', 'facts', 'sessions', 'archive']);
    for (const scope of purgeScopes()) expect(scope.label.length).toBeGreaterThan(0);
  });
});

describe('formatBytes', () => {
  it('字节/非法值边界', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('KB/MB 单位与小数位', () => {
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(100 * 1024)).toBe('100 KB');
  });
});

describe('purgeSummary / purgeDeletedTotal', () => {
  it('would_delete 汇总成单行文案', () => {
    expect(purgeSummary(wouldDelete)).toBe(
      '事实 1 · 边 2 · 实体 3 · 注解 4 · 会话 5 · 归档文件 6',
    );
  });

  it('实跑删除总数不含归档文件', () => {
    expect(purgeDeletedTotal(wouldDelete)).toBe(15);
  });
});

describe('overviewRows', () => {
  it('7 行固定口径，数据库/归档/保留策略可读', () => {
    const rows = overviewRows(makeOverview());
    expect(rows.map((r) => r.label)).toEqual([
      '数据库',
      '事实 / 边 / 实体',
      '注解 / 会话',
      '软删 / 失效',
      '归档',
      '保留策略',
      '最近清理',
    ]);
    expect(rows[0]?.value).toBe('/home/u/.moshi/moshi.db · 12.50 MB · WAL 0.25 MB');
    expect(rows[1]?.value).toBe('120 条事实 · 60 条边 · 18 个实体');
    expect(rows[2]?.value).toBe('7 条注解 · 3 个会话');
    expect(rows[3]?.value).toBe('2 条 pruned · 5 条 invalidated');
    expect(rows[4]?.value).toContain('/home/u/Documents/默识归档');
    expect(rows[4]?.value).toContain('4 个主题（DB 台账 4）');
    expect(rows[4]?.value).toContain('2.00 KB');
    expect(rows[5]?.value).toBe('闲置 60 天 · 半衰期 14 天');
    expect(rows[6]?.value).toBe('从未');
  });

  it('last_purge_at 有值时原样展示；归档字节为 0 时显示 0 B', () => {
    const rows = overviewRows(
      makeOverview({
        last_purge_at: '2026-11-01T03:00:12.000Z',
        archive: { dir: '/tmp/arc', topics: 0, bytes: 0 },
      }),
    );
    expect(rows[6]?.value).toBe('2026-11-01T03:00:12.000Z');
    expect(rows[4]?.value).toContain('0 B');
  });
});

describe('evalRunText', () => {
  it('409 并发优先于 body 判定', () => {
    expect(evalRunText({ ok: true, passed: 1, total: 1 }, 409)).toBe('已有评测在跑');
  });

  it('no_golden_set 与门禁失败分别给文案', () => {
    expect(evalRunText({ ok: false, reason: 'no_golden_set' })).toBe('未配置 golden set');
    expect(evalRunText({ ok: false, reason: 'gate_failed' })).toBe('评测未通过门禁');
  });

  it('完成出口含通过数/阻断/耗时；无耗时则省略', () => {
    expect(
      evalRunText({ ok: true, passed: 8, total: 10, blocking_failures: 2, elapsed_ms: 1234 }),
    ).toBe('评测完成：8/10 通过 · 阻断 2 次 · 1234ms');
    expect(evalRunText({ ok: true, passed: 10, total: 10, blocking_failures: 0 })).toBe(
      '评测完成：10/10 通过 · 阻断 0 次',
    );
  });
});
