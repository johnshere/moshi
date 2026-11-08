import { describe, expect, it } from 'vitest';
import { scopeLabel, scopeOptions } from '../../src/ui/shell/scope-options.js';

const ITEMS = [
  { scope: 'global', fact_count: 12 },
  { scope: 'project:c:/work/a', fact_count: 3 },
  { scope: 'project:c:/work/b', fact_count: 0 },
];

describe('scopeOptions（V-02）', () => {
  it('全部 → 全局 → 项目，带计数', () => {
    expect(scopeOptions(ITEMS, null)).toEqual([
      { value: '', label: '全部作用域', count: null },
      { value: 'global', label: '全局', count: 12 },
      { value: 'project:c:/work/a', label: 'c:/work/a', count: 3 },
      { value: 'project:c:/work/b', label: 'c:/work/b', count: 0 },
    ]);
  });

  it('当前值不在清单里也保留，避免下拉框空白', () => {
    const options = scopeOptions(ITEMS, 'project:c:/gone');
    expect(options.at(-1)).toEqual({
      value: 'project:c:/gone',
      label: 'c:/gone',
      count: null,
    });
  });

  it('scopeLabel：全局 / 项目路径 / 未知原样', () => {
    expect(scopeLabel('global')).toBe('全局');
    expect(scopeLabel('project:c:/work/a')).toBe('c:/work/a');
    expect(scopeLabel('project:')).toBe('project:');
    expect(scopeLabel('weird')).toBe('weird');
  });
});
