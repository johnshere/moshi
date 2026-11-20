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
 *
 * 视觉（w10）：页头台账式，二级页签是一条 `.seg`（等宽小字 + 选中下沿信号线），
 * 每屏一句说明落在 `.station-note`，面板各用 `.band`，不再套卡片。
 */
import type { ReactElement } from 'react';
import { navigate } from '../shell/navigate.js';
import { SETTINGS_SECTIONS, settingsHref, type SettingsSection } from '../shell/pure.js';
import { useT } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';
import { ConfigForm } from './ConfigForm.js';
import { DiagPanel } from './DiagPanel.js';
import { MaintenancePanel } from './MaintenancePanel.js';
import { PrivacyPanel } from './PrivacyPanel.js';
import { UpdatePanel } from './UpdatePanel.js';

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
    <div className="ledger ledger-fill" data-testid="settings-page" data-section={section}>
      <header className="ledger-head">
        <div className="ledger-title">{t('settings.title')}</div>
        {/* 二级页签：左侧菜单树也能进，这里再给一排页签，省得来回看左栏 */}
        <div className="ledger-tools">
          <div className="seg settings-tabs" data-testid="settings-tabs" role="tablist">
            {SETTINGS_SECTIONS.map((item) => (
              <a
                key={item.key}
                href={settingsHref(item.key, window.location.search)}
                aria-current={item.key === section ? 'page' : undefined}
                role="tab"
                aria-selected={item.key === section}
                data-testid={`settings-tab-${item.key}`}
                data-active={item.key === section ? 'true' : 'false'}
                className="seg-item"
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
        </div>
      </header>

      <div className="station-body">
        <p className="station-note">{t(HINTS[section])}</p>
        <div className="settings-stack">
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
    </div>
  );
}
