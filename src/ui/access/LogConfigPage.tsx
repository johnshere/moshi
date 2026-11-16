/**
 * 接入 →「日志与保留」（用户 m00882：原 设置 › 接入与日志 并入一级「接入」）。
 *
 * 外壳只负责标题与一句说明；表单本体仍是 `settings/AccessLogsPanel`（唯一写入口），
 * 不在这里复制一份，避免两处口径分叉。
 */
import type { ReactElement } from 'react';
import { AccessLogsPanel } from '../settings/AccessLogsPanel.js';

export function LogConfigPage(): ReactElement {
  return (
    <div
      data-testid="log-config-page"
      style={{ position: 'absolute', inset: 0, overflow: 'auto', background: 'var(--color-bg-base)' }}
    >
      <div style={{ padding: '14px 18px 0', color: 'var(--color-text-primary)', fontSize: 15, fontWeight: 600 }}>
        日志与保留
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 12, padding: '4px 18px 12px' }}>
        查询日志保留与清空、插件运行日志档位；这是唯一写入口，日志页的开关只是跳回这里。
      </div>
      <div style={{ padding: '0 18px 18px' }}>
        <AccessLogsPanel />
      </div>
    </div>
  );
}
