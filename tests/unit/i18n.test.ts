/**
 * UI 国际化基建的单元测试（D-184 / V-09 S1）。
 *
 * 覆盖三件事：
 * 1. 词表完整性：`en` 与 `zh` 键集一致（类型层已由 `satisfies Record<DictKey, string>` 钉住，
 *    这里再守一次运行时，防止有人绕开类型塞值）；
 * 2. 占位替换：`{name}` 用 vars 换，缺参时保留原样（便于一眼看出漏传）；
 * 3. 枚举映射：已知值出文案，未知值原样返回（后端加了新枚举，界面不应显示 `undefined`）。
 */
import { describe, expect, it } from 'vitest';
import { zh, type DictKey } from '../../src/ui/i18n/dict.js';
import { en } from '../../src/ui/i18n/dict.en.js';
import { enumLabel } from '../../src/ui/i18n/enums.js';
import { hasKey, translate } from '../../src/ui/i18n/index.js';

const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();

describe('词表完整性', () => {
  it('en 与 zh 键集完全一致', () => {
    expect(enKeys).toEqual(zhKeys);
  });

  it('没有空串文案', () => {
    for (const key of zhKeys) {
      expect(zh[key as DictKey]).not.toBe('');
      expect(en[key as DictKey]).not.toBe('');
    }
  });

  it('英文词条里没有残留中文（数据占位除外）', () => {
    // 允许的例外：语言切换器里中文用中文名自称（`locale.zh` = 中）。
    const allowed = new Set<DictKey>(['locale.zh']);
    for (const key of enKeys) {
      if (allowed.has(key as DictKey)) continue;
      expect(/[\u4e00-\u9fff]/.test(en[key as DictKey])).toBe(false);
    }
  });

  it('hasKey 认得已知键、拒绝未知键', () => {
    expect(hasKey('app.brand')).toBe(true);
    expect(hasKey('nope.not.a.key')).toBe(false);
  });
});

describe('translate', () => {
  it('按语言取文案', () => {
    expect(translate('zh', 'nav.memories')).toBe('记忆');
    expect(translate('en', 'nav.memories')).toBe('Memories');
  });

  it('{name} 占位用 vars 替换，可重复出现', () => {
    expect(translate('zh', 'topbar.inbox.badge', { count: 3 })).toBe('待办 3');
    expect(translate('en', 'topbar.inbox.badge', { count: 3 })).toBe('Inbox 3');
    expect(translate('en', 'endpoints.import.status.running', { elapsed: '00:12' })).toBe(
      'Running · elapsed 00:12',
    );
  });

  it('缺参时保留占位符，不静默吞掉', () => {
    expect(translate('zh', 'endpoints.import.status.failed')).toContain('{error}');
  });
});

describe('enumLabel', () => {
  it('已知值按语言出文案', () => {
    expect(enumLabel('ftype', 'semantic')).toBe('语义');
    expect(enumLabel('epistemic', 'archived')).toBe('已归档');
    expect(translate('en', 'enum.ftype.semantic')).toBe('Semantic');
  });

  it('未知值原样返回（后端新增枚举不显示 undefined）', () => {
    expect(enumLabel('ftype', 'brand_new_kind')).toBe('brand_new_kind');
  });
});
