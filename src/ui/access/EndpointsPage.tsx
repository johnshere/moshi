/**
 * 接入点页（P4；开发方案 §7）。
 *
 * 上排是四类接入点的运行态（数据来自同一份 `GET /api/logs/summary`），
 * 下半屏内嵌 Magpie 插件的安装/连接面板（原 `/ui/hook` 与设置里的「接入」
 * 共用 `AccessPage`，用户 m02743 把它迁到这里）。
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { AccessPage } from './AccessPage.js';
import { fetchLogsSummary, type LogsSummaryGroup } from './api.js';

const ENDPOINTS: readonly { kind: string; label: string; desc: string }[] = [
  { kind: 'gateway', label: '网关（Magpie）', desc: 'LLM 网关钩子：每次请求做一次召回，把记忆注入 system。' },
  { kind: 'mcp', label: 'MCP', desc: 'MCP 服务器：memory_query / annotate / feedback / correct 四个工具。' },
  { kind: 'cli', label: '命令行', desc: '`moshi` CLI 的检索与维护命令（本地直连）。' },
  { kind: 'ui', label: '界面', desc: '本界面里的检索与图谱交互。' },
];

const cardStyle: CSSProperties = {
  border: '1px solid var(--color-border, #2a333d)',
  borderRadius: 8,
  background: 'var(--color-bg-raised)',
  padding: '10px 12px',
  minWidth: 220,
  flex: '1 1 220px',
};

function fmtTime(ts: string | null): string {
  if (ts === null) return '—';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString('zh-CN', { hour12: false });
}

export function EndpointsPage(): ReactElement {
  const [groups, setGroups] = useState<LogsSummaryGroup[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchLogsSummary('24h', controller.signal)
      .then((value) => {
        setGroups(value.groups);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    return () => controller.abort();
  }, []);

  const byKind = new Map<string, LogsSummaryGroup[]>();
  for (const group of groups) {
    const list = byKind.get(group.caller_kind) ?? [];
    list.push(group);
    byKind.set(group.caller_kind, list);
  }

  return (
    <div
      data-testid="endpoints-page"
      style={{ position: 'absolute', inset: 0, overflow: 'auto', background: 'var(--color-bg-base)' }}
    >
      <div style={{ padding: '14px 18px 0', color: 'var(--color-text-primary)', fontSize: 15, fontWeight: 600 }}>
        接入点
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 12, padding: '4px 18px 10px' }}>
        四类接入点共用同一个记录面；下面是过去 24 小时的运行态，配置在设置 →「接入与日志」。
      </div>
      {error !== null ? (
        <div style={{ color: 'var(--color-danger, #f85149)', fontSize: 12, padding: '0 18px 8px' }}>
          统计读取失败：{error}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 10, padding: '0 18px', flexWrap: 'wrap' }}>
        {ENDPOINTS.map((endpoint) => {
          const list = byKind.get(endpoint.kind) ?? [];
          const count = list.reduce((sum, item) => sum + item.count, 0);
          const ok = list.reduce((sum, item) => sum + item.ok, 0);
          const last = list.reduce<string | null>((acc, item) => {
            if (item.last_ts === null) return acc;
            return acc === null || item.last_ts > acc ? item.last_ts : acc;
          }, null);
          return (
            <div key={endpoint.kind} data-testid={`endpoint-card-${endpoint.kind}`} style={cardStyle}>
              <div style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>{endpoint.label}</div>
              <div style={{ fontSize: 20, color: 'var(--color-text-primary)', margin: '2px 0' }}>
                {count}
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 6 }}>次 / 24h</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                成功 {ok} · 最近 {fmtTime(last)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>{endpoint.desc}</div>
              {list.map((group) => (
                <div key={`${group.caller_id}:${group.caller_kind}`} style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                  {group.caller_id} · {group.count} 次 · P95{' '}
                  {group.p95_ms === null ? '—' : `${String(Math.round(group.p95_ms))}ms`}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div style={{ padding: '16px 18px 6px', color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 600 }}>
        Magpie 插件
      </div>
      <div style={{ padding: '0 18px 24px' }}>
        <AccessPage standalone={false} onboardResult={null} />
      </div>
    </div>
  );
}
