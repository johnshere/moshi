import { describe, expect, it } from 'vitest';
import { actionText, manualTextKey, noteText, reasonText, riskText, type HookHost } from '../../src/ui/access/plan.js';
import { hasKey, translate } from '../../src/ui/i18n/index.js';

/**
 * 安装计划码值 → 文案（I-70 / D-187）。
 *
 * 这里守的是两条边界纪律：
 *  - 服务端只下发码值，界面负责拼句子（含 `note` 的路径/spec 数据）；
 *  - 未知码与旧值（老版本 `onboarding.json` 里存的中文）必须原样显示，不能空白。
 */
describe('access/plan 码值文案', () => {
  it('动作码走词典，未知码原样返回', () => {
    expect(actionText('add')).toBe('新增');
    expect(actionText('update')).toBe('修改');
    expect(actionText('remove')).toBe('删除');
    expect(actionText('revive')).toBe('revive');
  });

  it('原因码：null / 空串给空串，未知码与旧中文原样', () => {
    expect(reasonText(null)).toBe('');
    expect(reasonText(undefined)).toBe('');
    expect(reasonText('')).toBe('');
    expect(reasonText('mcp_not_implemented')).toContain('MCP');
    expect(reasonText('host_plugin_missing')).toContain('§11.2');
    // 上一版 onboarding.json 里存的是整句中文，升级后照样能显示
    expect(reasonText('缺少宿主内插件（设计 §11.2 未实现）')).toBe('缺少宿主内插件（设计 §11.2 未实现）');
    expect(reasonText('brand_new_code')).toBe('brand_new_code');
  });

  it('风险码 → 整句，null 给空串', () => {
    expect(riskText('reload_plugin_host')).toContain('plugin-host');
    expect(riskText(null)).toBe('');
    expect(riskText('unknown_risk')).toBe('unknown_risk');
  });

  it('步骤附注：码 + 数据拼句，旧字符串原样，缺省 null', () => {
    expect(noteText(undefined)).toBeNull();
    expect(noteText({ code: 'from_package', file: '/x/moshi/hook.cjs' })).toBe(
      translate('zh', 'access.note.fromPackage', { file: '/x/moshi/hook.cjs' }),
    );
    expect(noteText({ code: 'registry_present' })).toBe(translate('zh', 'access.note.registryPresent'));
    expect(noteText({ code: 'registry_add', spec: '/x/moshi' })).toBe(
      translate('zh', 'access.note.registryAdd', { spec: '/x/moshi' }),
    );
    expect(noteText('来自旧版本的整句附注')).toBe('来自旧版本的整句附注');
  });

  it('手动安装文案：六个组合各有键，且中英都在词典里', () => {
    const hosts: readonly HookHost[] = ['magpie', 'claude-code', 'dsh'];
    const keys = hosts.flatMap((host) => [manualTextKey(host, 'hook'), manualTextKey(host, 'mcp')]);
    expect(new Set(keys).size).toBe(6);
    for (const key of keys) {
      expect(hasKey(key)).toBe(true);
      expect(translate('zh', key).length).toBeGreaterThan(10);
      expect(translate('en', key).length).toBeGreaterThan(10);
      expect(translate('en', key)).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
