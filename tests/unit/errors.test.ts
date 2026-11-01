/**
 * P1-11 失败语义与降级映射单测（详设 §6.13；台账 P1-11）。
 *
 * 验收：逐项关闭 bm25/ppr/vector/gat → degraded 数组正确；查失败绝不报
 * ok+空（有信号必 degraded）；ok+空 允许（查到但无可靠证据）。
 */
import { describe, expect, it } from 'vitest';
import { mapDegradation, SIGNAL_TO_DEGRADED } from '../../src/core/read/errors.js';

describe('失败语义与降级映射（P1-11）', () => {
  it('逐项关闭：bm25/ppr/vector/gat 映射到正确码', () => {
    expect(mapDegradation(['bm25_error'])).toEqual({ degraded: ['no_bm25'], status: 'degraded' });
    expect(mapDegradation(['ppr_timeout'])).toEqual({ degraded: ['no_ppr'], status: 'degraded' });
    expect(mapDegradation(['ppr_error'])).toEqual({ degraded: ['no_ppr'], status: 'degraded' });
    expect(mapDegradation(['vector_error'])).toEqual({ degraded: ['no_vector'], status: 'degraded' });
    expect(mapDegradation(['gat_unavailable'])).toEqual({ degraded: ['no_model'], status: 'degraded' });
    expect(mapDegradation(['sidecar_unavailable'])).toEqual({ degraded: ['no_sidecar'], status: 'degraded' });
    expect(mapDegradation(['query_timeout'])).toEqual({ degraded: ['timeout'], status: 'degraded' });
    expect(mapDegradation(['cold_start'])).toEqual({ degraded: ['cold_start'], status: 'degraded' });
    expect(mapDegradation(['summary_missing'])).toEqual({ degraded: ['no_summary'], status: 'degraded' });
  });

  it('多信号去重并按枚举序稳定', () => {
    expect(mapDegradation(['ppr_timeout', 'bm25_error', 'vector_error', 'ppr_error'])).toEqual({
      degraded: ['no_bm25', 'no_ppr', 'no_vector'],
      status: 'degraded',
    });
    expect(mapDegradation(['sidecar_unavailable', 'sidecar_unavailable'])).toEqual({ degraded: ['no_sidecar'], status: 'degraded' });
  });

  it('查失败绝不报 ok + 空：有信号必 degraded，即使 evidence 空', () => {
    // 编排层语义：signals 非空 → status degraded（本层不关心 evidence）
    const res = mapDegradation(['bm25_error']);
    expect(res.status).toBe('degraded');
    expect(res.degraded).toContain('no_bm25');
    // 空 signals + 空 evidence = 正常"查到但无可靠证据"，ok 允许
    const ok = mapDegradation([]);
    expect(ok.status).toBe('ok');
    expect(ok.degraded).toEqual([]);
  });

  it('信号码都在 DEGRADED 枚举内', () => {
    for (const code of Object.values(SIGNAL_TO_DEGRADED)) {
      expect(['no_model', 'timeout', 'no_bm25', 'no_ppr', 'no_vector', 'no_sidecar', 'cold_start', 'no_summary']).toContain(code);
    }
  });
});
