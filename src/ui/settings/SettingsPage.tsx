/**
 * 设置页（P2-19-A 起；Z-01C-g 按设计 §16.5.3 拆成二级）。
 *
 * 原来是设置里的「接入与日志」在最前，用户 m00882 要求接入相关的全部并入一级「接入」，
 * 所以现在设置只剩四个二级，一个二级一屏：
 *
 *   配置 → ConfigForm（白名单键，原子写回 YAML）
 *   维护 → MaintenancePanel（索引重建）+ UpdatePanel（自动更新）
 *   隐私 → PrivacyPanel（采集/脱敏/导出/清理）
 *   诊断 → DiagPanel（只读自检 I1–I10 / 图质量 / 模型归档）
 *
 * 分类边界（P4 起）：**日志与接入参数归「接入」一级页（日志 / 接入点；日志与保留
 * 按用户 m01083 是日志页里的弹框），配置唯一写入口留在设置**。
 */
import type { CSSProperties, ReactElement } from 'react';
import { navigate } from '../shell/navigate.js';
import { SETTINGS_SECTIONS, settingsHref, type SettingsSection } from '../shell/pure.js';
import { useT } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';
import { ConfigForm } from './ConfigForm.js';
import { DiagPanel } from './DiagPanel.js';
import { MaintenancePanel } from './MaintenancePanel.js';
import { PrivacyPanel } from './PrivacyPanel.js';
import { UpdatePanel } from './UpdatePanel.js';

const tabStyle = (active: boolean): CSSProperties => ({
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid ' + (active ? 'var(--color-border-strong, #3a4a5a)' : 'transparent'),
  background: active ? 'var(--color-bg-raised)' : 'transparent',
  color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
  fontSize: 12,
  cursor: 'pointer',
  textDecoration: 'none',
});

/** 二级标题与说明：每屏一句，别让人猜这一屏管什么。 */
const HINTS: Record<SettingsSection, DictKey> = {
  config: 'settings.hint.config',
  maintain: 'settings.hint.maintain',
  privacy: 'settings.hint.privacy',
  diagnose: 'settings.hint.diagnose',
};

export interface SettingsPageProps {
  /** 当前二级（由 URL 决定，`/ui/settings` 默认配置） */
  section: SettingsSection;
}

export function SettingsPage({ section }: SettingsPageProps): ReactElement {
  const t = useT();
  return (
    <div
      data-testid="settings-page"
      data-section={section}
      style={{ position: 'absolute', inset: 0, overflow: 'auto', background: 'var(--color-bg-base)' }}
    >
      <div style={{ padding: '14px 18px 0', color: 'var(--color-text-primary)', fontSize: 15, fontWeight: 600 }}>{t('settings.title')}</div>
      {/* 二级页签：左侧菜单树也能进，这里再给一排页签，省得来回看左栏 */}
      <div
        data-testid="settings-tabs"
        style={{ display: 'flex', gap: 6, padding: '10px 18px 0', flexWrap: 'wrap' }}
      >
        {SETTINGS_SECTIONS.map((item) => (
          <a
            key={item.key}
            href={settingsHref(item.key, window.location.search)}
            aria-current={item.key === section ? 'page' : undefined}
            data-testid={`settings-tab-${item.key}`}
            data-active={item.key === section ? 'true' : 'false'}
            style={tabStyle(item.key === section)}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate(settingsHref(item.key, window.location.search));
            }}
            title={t(item.titleKey)}
          >
            {t(item.labelKey)}
          </a>
        ))}
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 12, padding: '8px 18px 10px' }}>{t(HINTS[section])}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '0 18px 18px' }}>
        {section === 'config' ? <ConfigForm /> : null}
        {section === 'maintain' ? (
          <>
            <MaintenancePanel />
            <UpdatePanel />
          </>
        ) : null}
        {section === 'privacy' ? <PrivacyPanel /> : null}
        {section === 'diagnose' ? <DiagPanel /> : null}
      </div>
    </div>
  );
}
