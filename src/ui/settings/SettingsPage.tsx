/**
 * 设置与诊断页（P2-19-A / P2-19A-06，详设 §10.1）。
 *
 * 三块：配置表单（GET/PUT /api/config）、维护重建（POST /api/maintenance/rebuild）、
 * 只读自检（既有 DiagPanel，P2-18）。不新增接口符号之外的契约（D-89）。
 */
import type { ReactElement } from 'react';
import { ConfigForm } from './ConfigForm.js';
import { DiagPanel } from './DiagPanel.js';
import { MaintenancePanel } from './MaintenancePanel.js';
import { PrivacyPanel } from './PrivacyPanel.js';
import { UpdatePanel } from './UpdatePanel.js';

export function SettingsPage(): ReactElement {
  return (
    <div
      data-testid="settings-page"
      style={{ position: 'absolute', inset: 0, overflow: 'auto', background: 'var(--color-bg-base)' }}
    >
      <div style={{ padding: '14px 18px 0', color: 'var(--color-text-primary)', fontSize: 15, fontWeight: 600 }}>
        设置与诊断
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 12, padding: '4px 18px 10px' }}>
        配置（白名单键，原子写回 TOML）、索引维护、隐私与全库导出，以及只读自检（I1–I10 / 图质量 / 模型归档）。
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '0 18px 18px' }}>
        <ConfigForm />
        <UpdatePanel />
        <MaintenancePanel />
        <PrivacyPanel />
        <DiagPanel />
      </div>
    </div>
  );
}
