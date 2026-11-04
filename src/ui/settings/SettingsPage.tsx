/**
 * 设置与诊断页（P2-19-A，详设 §10.1）：只挂载既有 DiagPanel（P2-18）。
 *
 * 不做配置编辑（P2-19-B 视觉/交互另议），这里只是给诊断面板一个一级入口，
 * 读取仍走 `GET /api/diag`，不新增接口（D-89）。
 */
import type { ReactElement } from 'react';
import { DiagPanel } from './DiagPanel.js';

export function SettingsPage(): ReactElement {
  return (
    <div
      data-testid="settings-page"
      style={{ position: 'absolute', inset: 0, overflow: 'auto', background: '#070c16' }}
    >
      <div style={{ padding: '14px 18px 0', color: '#e2e8f0', fontSize: 15, fontWeight: 600 }}>
        设置与诊断
      </div>
      <div style={{ color: '#64748b', fontSize: 12, padding: '4px 18px 10px' }}>
        自检红绿灯（I1–I10）、索引、图质量与最近 harvest；只读，不触发重建。
      </div>
      <DiagPanel />
    </div>
  );
}
