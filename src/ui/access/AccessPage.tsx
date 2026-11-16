/**
 * 接入页（Z-01C-g / 设计 §16.5.4、§16.5.5）：Hook 插件与 MCP 的接入状态、开关、台账。
 *
 * **一个组件，两个外壳**：
 * - 独立整页 `/ui/hook`（`standalone`，外部契约：`magpie.cmd` 用它拉起界面）；
 * - 接入二级 `/ui/access/endpoints`（内嵌，不带整页标题与返回）。
 *
 * 为什么不能做成 iframe 内嵌：旧版 `/ui/hook` 是服务端拼的内联 HTML，嵌进来会有
 * 两层滚动、两套令牌处理。这里把功能搬进 React，两个路由共用一个组件（§16.5.5）。
 *
 * 取数分工（§16.3）：
 * - `/hook/api/status` 5s 轮询（轻）；
 * - `/hook/api/trace` 5s 轮询（轻）；
 * - `/hook/api/install/plan` 打开时取一次（重，含磁盘检查），装/卸后再取；
 * - `/hook/api/detect` 打开时取一次缓存（60s），只有用户点「重新探测」才强制。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { resolveToken } from '../api.js';
import { useT } from '../i18n/index.js';
import { enumLabel } from '../i18n/enums.js';
import {
  actionText,
  manualTextKey,
  noteText,
  reasonText,
  riskText,
  type HookHost,
  type InstallPlan,
  type PlanPayload,
} from './plan.js';

// ── 服务端契约（TS 侧镜像，服务端不导给 UI，避免 UI 依赖 app 层） ──
// 安装计划（InstallPlan / PlanPayload）与它的码→文案映射在 `./plan.js`（I-70 / D-187）。

export type { HookHost } from './plan.js';

export type InstallState = 'absent' | 'installed' | 'failed' | 'unsupported';

export interface HookSwitches {
  enabled: boolean;
  inject_existing: boolean;
  capture_reply: boolean;
  magpie_enabled: boolean;
}

export interface HookStatusPayload {
  connected: boolean;
  needs_connect: boolean;
  switches: HookSwitches;
  trace_size: number;
}

export interface TraceItem {
  ts: string;
  host: string;
  turn: string;
  status: string;
  inject_bytes: number;
  evidence: number;
  degraded: readonly string[];
  latency_ms: number;
}

export interface TracePayload {
  items: readonly TraceItem[];
  capacity: number;
}

export interface InstallRecord {
  state: InstallState;
  at: string | null;
  path: string | null;
  version: string | null;
  reason: string | null;
  files: readonly string[];
  backup: string | null;
}

export interface OnboardPayload {
  should_prompt: boolean;
  detected: { at: string; hosts: Record<HookHost, { hit: boolean; via: readonly string[] }> } | null;
  installs: Record<string, InstallRecord>;
  labels: Record<HookHost, string>;
}

// ── 文案表（一处定义，服务端只给宿主名） ──

// turn / outcome / install 三个枚举的文案在 `../i18n/dict.ts` 的 `enum.*` 下，
// 统一经 `enumLabel()` 取（D-184：后端枚举值不翻译，界面文案才翻译）。

// ── 样式 ──

const pageStyle = (standalone: boolean): CSSProperties =>
  standalone
    ? { position: 'absolute', inset: 0, overflow: 'auto', padding: '18px 22px 32px', boxSizing: 'border-box' }
    : // 内嵌在设置页里：**不能**绝对定位，否则会盖住二级页签与说明
      { padding: '0 0 8px', boxSizing: 'border-box' };

const titleStyle: CSSProperties = {
  color: 'var(--color-text-primary)',
  fontSize: 18,
  fontWeight: 600,
  margin: 0,
};

const subtitleStyle: CSSProperties = {
  color: 'var(--color-text-faint)',
  fontSize: 12,
  marginTop: 4,
  lineHeight: 1.6,
};

const cardStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  padding: '14px 16px',
  marginTop: 14,
};

const cardTitleStyle: CSSProperties = {
  color: 'var(--color-text-primary)',
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 10,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 0',
  borderTop: '1px solid var(--color-border-subtle)',
};

const mutedStyle: CSSProperties = {
  color: 'var(--color-text-faint)',
  fontSize: 12,
};

function buttonStyle(disabled = false): CSSProperties {
  return {
    padding: '5px 12px',
    borderRadius: 5,
    border: '1px solid var(--color-border-subtle)',
    background: disabled ? 'transparent' : 'var(--color-bg-overlay)',
    color: disabled ? 'var(--color-text-faint)' : 'var(--color-text-primary)',
    fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

const linkButtonStyle: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--color-status-info, #4a9eff)',
  fontSize: 12,
  cursor: 'pointer',
  textDecoration: 'underline',
};

// ── HTTP ──

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: {
      'X-Moshi-Token': resolveToken(),
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as T;
}

const POLL_MS = 5000;

export interface AccessPageProps {
  /** 独立整页（`/ui/hook`）时为 true：渲染整页标题与「返回应用」 */
  standalone: boolean;
  /** 首启弹窗装完跳过来的结果（`?from=onboard&result=ok|fail`） */
  onboardResult: 'ok' | 'fail' | null;
}

export function AccessPage({ standalone, onboardResult }: AccessPageProps): ReactElement {
  const t = useT();
  const [status, setStatus] = useState<HookStatusPayload | null>(null);
  const [plans, setPlans] = useState<PlanPayload | null>(null);
  const [onboard, setOnboard] = useState<OnboardPayload | null>(null);
  const [trace, setTrace] = useState<TracePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 手动安装弹窗 / 二次确认弹窗：二选一，互相顶掉 */
  const [manual, setManual] = useState<{ host: HookHost; kind: 'hook' | 'mcp' } | null>(null);
  const [confirming, setConfirming] = useState<InstallPlan | null>(null);
  const [resultText, setResultText] = useState<string | null>(
    onboardResult === null ? null : t(onboardResult === 'ok' ? 'access.onboard.ok' : 'access.onboard.fail'),
  );
  /** 结果条色调：安装失败要红；以前靠字符串里有没有「失败」猜，翻译后不能这么猜了 */
  const [resultTone, setResultTone] = useState<'ok' | 'fail'>(onboardResult === 'fail' ? 'fail' : 'ok');
  const disposedRef = useRef(false);

  const fail = useCallback((err: unknown): void => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await api<HookStatusPayload>('/hook/api/status');
      if (!disposedRef.current) setStatus(next);
    } catch (err) {
      if (!disposedRef.current) fail(err);
    }
  }, [fail]);

  const loadTrace = useCallback(async (): Promise<void> => {
    try {
      const next = await api<TracePayload>('/hook/api/trace?limit=20');
      if (!disposedRef.current) setTrace(next);
    } catch {
      // 台账取不到不算错：不影响开关与安装
    }
  }, []);

  const loadStatic = useCallback(async (): Promise<void> => {
    try {
      const [plan, ob] = await Promise.all([
        api<PlanPayload>('/hook/api/install/plan'),
        api<OnboardPayload>('/hook/api/onboard'),
      ]);
      if (disposedRef.current) return;
      setPlans(plan);
      setOnboard(ob);
    } catch (err) {
      if (!disposedRef.current) fail(err);
    }
  }, [fail]);

  useEffect(() => {
    disposedRef.current = false;
    void loadStatus();
    void loadStatic();
    void loadTrace();
    // 「打开过界面」只在第一次落（服务端保证），用来区分首装与日常打开
    void api<OnboardPayload>('/hook/api/onboard', { method: 'POST', body: { open: true } }).catch(() => undefined);
    const timer = window.setInterval(() => {
      void loadStatus();
      void loadTrace();
    }, POLL_MS);
    return () => {
      disposedRef.current = true;
      window.clearInterval(timer);
    };
  }, [loadStatus, loadStatic, loadTrace]);

  // 首启弹窗装完会导航到 `?from=onboard&result=…`。同一路由内 pushState 不会重挂组件，
  // 所以结果条与安装状态必须跟着 props 更新（否则停在「未安装」直到刷新页面）。
  useEffect(() => {
    if (onboardResult === null) return;
    setResultText(t(onboardResult === 'ok' ? 'access.onboard.ok' : 'access.onboard.fail'));
    setResultTone(onboardResult === 'ok' ? 'ok' : 'fail');
    void loadStatic();
  }, [onboardResult, loadStatic, t]);

  const setSwitch = async (patch: Partial<HookSwitches>): Promise<void> => {
    setBusy('config');
    try {
      await api('/hook/api/config', { method: 'POST', body: patch });
      setResultText(null);
      await loadStatus();
      await loadStatic();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const connect = async (action: 'connect' | 'disconnect'): Promise<void> => {
    setBusy('connect');
    try {
      await api('/hook/api/config', { method: 'POST', body: { action } });
      await loadStatus();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const runInstall = async (plan: InstallPlan): Promise<void> => {
    setBusy(`install:${plan.host}:${plan.kind}`);
    try {
      const body = { host: plan.host, kind: plan.kind, confirm: true };
      const res = await api<{ ok: boolean; record: InstallRecord }>('/hook/api/install', { method: 'POST', body });
      setResultText(
        res.ok
          ? t('access.result.installed', { path: res.record.path ?? t('access.result.targetDir') })
          : t('access.result.installFail', {
              reason: reasonText(res.record.reason) || t('access.result.unknownReason'),
            }),
      );
      setResultTone(res.ok ? 'ok' : 'fail');
      setConfirming(null);
      await loadStatic();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const runUninstall = async (plan: InstallPlan): Promise<void> => {
    setBusy(`uninstall:${plan.host}:${plan.kind}`);
    try {
      await api('/hook/api/uninstall', { method: 'POST', body: { host: plan.host, kind: plan.kind } });
      setResultText(t('access.result.uninstalled'));
      setResultTone('ok');
      await loadStatic();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const connected = status?.connected === true;
  const needsConnect = status?.needs_connect === true && !connected;

  const recordOf = (plan: InstallPlan): InstallRecord | null => {
    const key = plans?.keys.find((k) => k.host === plan.host && k.kind === plan.kind)?.key;
    if (key === undefined || onboard === null) return null;
    return onboard.installs[key] ?? null;
  };

  return (
    <div style={pageStyle(standalone)} data-testid="access-page">
      {standalone ? (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h2 style={titleStyle}>{t('access.title')}</h2>
          <a href={`/ui/graph${window.location.search}`} style={{ ...linkButtonStyle, fontSize: 12 }} data-testid="access-back">
            {t('access.back')}
          </a>
        </div>
      ) : null}
      <div style={subtitleStyle}>
        {t('access.intro')}
      </div>

      {resultText !== null ? (
        <div style={{ ...cardStyle, borderColor: 'var(--color-border-strong, #3a4a5a)' }} data-testid="access-result" data-tone={resultTone}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>{resultText}</span>
            <button type="button" style={linkButtonStyle} onClick={() => setResultText(null)}>
              {t('common.close')}
            </button>
          </div>
        </div>
      ) : null}

      {error !== null ? (
        <div style={{ ...cardStyle, borderColor: 'var(--color-status-error, #e05252)' }} data-testid="access-error">
          <span style={{ fontSize: 12, color: 'var(--color-status-error, #e05252)' }}>{error}</span>
        </div>
      ) : null}

      {/* ── 连接态 + 工程身份 ── */}
      <div style={cardStyle} data-testid="access-connection">
        <div style={cardTitleStyle}>{t('access.conn.title')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            data-testid="access-connected"
            data-connected={connected ? 'true' : 'false'}
            style={{
              fontSize: 12,
              padding: '2px 8px',
              borderRadius: 999,
              border: '1px solid var(--color-border-subtle)',
              color: connected ? 'var(--color-status-ok, #4caf50)' : 'var(--color-text-faint)',
            }}
          >
            {connected ? t('access.conn.connected') : t('access.conn.disconnected')}
          </span>
          <button
            type="button"
            data-testid="access-connect-toggle"
            style={buttonStyle(busy !== null)}
            disabled={busy !== null}
            onClick={() => void connect(connected ? 'disconnect' : 'connect')}
          >
            {connected ? t('access.conn.disconnect') : t('access.conn.connect')}
          </button>
          <span style={mutedStyle}>{t('access.conn.hint')}</span>
        </div>
      </div>

      {/* ── 三个真开关（magpie_enabled 由连接按钮驱动，不单独给开关，避免两处语义打架） ── */}
      <div style={cardStyle} data-testid="access-switches">
        <div style={cardTitleStyle}>{t('access.switches.title')}</div>
        {(
          [
            ['enabled', 'access.switch.enabled.label', 'access.switch.enabled.desc'],
            ['inject_existing', 'access.switch.inject_existing.label', 'access.switch.inject_existing.desc'],
            ['capture_reply', 'access.switch.capture_reply.label', 'access.switch.capture_reply.desc'],
          ] as const
        ).map(([key, labelKey, hintKey]) => (
          <label key={key} style={{ ...rowStyle, cursor: 'pointer' }} data-testid={`access-switch-${key}`}>
            <input
              type="checkbox"
              checked={status?.switches[key] === true}
              disabled={status === null || busy !== null}
              onChange={(event) => void setSwitch({ [key]: event.target.checked })}
            />
            <span style={{ fontSize: 12, color: 'var(--color-text-primary)', minWidth: 110 }}>{t(labelKey)}</span>
            <span style={mutedStyle}>{t(hintKey)}</span>
          </label>
        ))}
      </div>

      {/* ── 接入矩阵：两大类 × 三个客户端 ── */}
      {(['hook', 'mcp'] as const).map((kind) => (
        <div style={cardStyle} key={kind} data-testid={`access-group-${kind}`}>
          <div style={cardTitleStyle}>{t(kind === 'hook' ? 'access.matrix.hook' : 'access.matrix.mcp')}</div>
          {kind === 'mcp' ? (
            <div style={{ ...mutedStyle, marginBottom: 6 }}>{t('access.matrix.note')}</div>
          ) : null}
          {(plans?.plans ?? [])
            .filter((plan) => plan.kind === kind)
            .map((plan) => {
              const record = recordOf(plan);
              const installed = record?.state === 'installed';
              const detected = onboard?.detected?.hosts[plan.host]?.hit === true;
              const label = plans?.labels[plan.host] ?? plan.host;
              const isMagpieHook = plan.host === 'magpie' && plan.kind === 'hook';
              return (
                <div key={`${plan.host}:${plan.kind}`} style={rowStyle} data-testid={`access-plan-${plan.host}-${plan.kind}`}>
                  <span style={{ fontSize: 13, color: 'var(--color-text-primary)', minWidth: 110 }}>
                    {label}
                    {detected ? <span style={{ ...mutedStyle, marginLeft: 6 }}>{t('access.matrix.detected')}</span> : null}
                  </span>
                  <span
                    data-testid={`access-state-${plan.host}-${plan.kind}`}
                    data-state={installed ? 'installed' : plan.supported ? 'absent' : 'unsupported'}
                    style={{ ...mutedStyle, minWidth: 150 }}
                  >
                    {installed
                      ? `${enumLabel('install', 'installed')}${record.version === null ? '' : ` v${record.version}`}`
                      : kind === 'mcp'
                        ? t('access.matrix.soon')
                        : plan.supported
                          ? enumLabel('install', 'absent')
                          : t('access.notSupported', {
                              label: enumLabel('install', 'unsupported'),
                              reason: reasonText(plan.reason),
                            })}
                  </span>
                  <span style={{ flex: 1 }} />
                  {isMagpieHook ? (
                    installed ? (
                      <button
                        type="button"
                        style={buttonStyle(busy !== null)}
                        disabled={busy !== null}
                        data-testid="access-uninstall"
                        onClick={() => void runUninstall(plan)}
                      >
                        {t('access.matrix.uninstall')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        style={buttonStyle(busy !== null)}
                        disabled={busy !== null}
                        data-testid="access-install"
                        onClick={() => setConfirming(plan)}
                      >
                        {t('access.matrix.install')}
                      </button>
                    )
                  ) : (
                    <button type="button" style={buttonStyle(true)} disabled data-testid={`access-soon-${plan.host}-${plan.kind}`}>
                      {t('access.matrix.soon')}
                    </button>
                  )}
                  <button
                    type="button"
                    style={linkButtonStyle}
                    data-testid={`access-manual-${plan.host}-${plan.kind}`}
                    onClick={() => setManual({ host: plan.host, kind: plan.kind })}
                  >
                    {t('access.matrix.manual')}
                  </button>
                </div>
              );
            })}
        </div>
      ))}

      {/* ── 注入台账 ── */}
      <div style={cardStyle} data-testid="access-trace">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={cardTitleStyle}>{t('access.trace.title')}</div>
          <span style={mutedStyle}>
            {t('access.trace.meta', { n: trace?.items.length ?? 0, capacity: trace?.capacity ?? 0 })}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={buttonStyle(false)}
            data-testid="access-trace-clear"
            onClick={() => {
              void api('/hook/api/trace', { method: 'POST', body: {} })
                .then(() => loadTrace())
                .catch(fail);
            }}
          >
            {t('access.trace.clear')}
          </button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
          <thead>
            <tr style={{ color: 'var(--color-text-faint)', textAlign: 'left' }}>
              <th style={{ padding: '4px 6px' }}>{t('access.trace.col.time')}</th>
              <th style={{ padding: '4px 6px' }}>{t('access.trace.col.turn')}</th>
              <th style={{ padding: '4px 6px' }}>{t('access.trace.col.outcome')}</th>
              <th style={{ padding: '4px 6px' }}>{t('access.trace.col.evidence')}</th>
              <th style={{ padding: '4px 6px' }}>{t('access.trace.col.bytes')}</th>
              <th style={{ padding: '4px 6px' }}>{t('access.trace.col.latency')}</th>
            </tr>
          </thead>
          <tbody>
            {(trace?.items ?? []).map((item, index) => (
              <tr key={`${item.ts}:${String(index)}`} style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
                <td style={{ padding: '4px 6px' }}>{item.ts.slice(11, 19)}</td>
                <td style={{ padding: '4px 6px' }}>{enumLabel('turn', item.turn)}</td>
                <td style={{ padding: '4px 6px' }}>
                  {enumLabel('outcome', item.status)}
                  {item.degraded.length > 0 ? (
                    <span style={mutedStyle}>{t('common.paren', { text: item.degraded.join('/') })}</span>
                  ) : null}
                </td>
                <td style={{ padding: '4px 6px' }}>{item.evidence}</td>
                <td style={{ padding: '4px 6px' }}>{item.inject_bytes}</td>
                <td style={{ padding: '4px 6px' }}>{item.latency_ms}ms</td>
              </tr>
            ))}
            {trace !== null && trace.items.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: '8px 6px', ...mutedStyle }}>
                  {t('access.trace.empty')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* ── F8 遮罩：断开过 Magpie 的情况下先要求连接，避免用户以为插件坏了 ──
          刚从首启弹窗装完跳过来时不遮：此刻要让用户先看到安装结果（结果条就在上面），
          连接按钮在「连接」卡片里，跑不掉。 */}
      {needsConnect && onboardResult === null ? (
        <div
          data-testid="access-mask"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 80,
            background: 'rgba(8, 12, 18, 0.82)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ ...cardStyle, marginTop: 0, maxWidth: 420, textAlign: 'center' }}>
            <div style={{ ...cardTitleStyle, fontSize: 15 }}>{t('access.gate.title')}</div>
            <div style={{ ...mutedStyle, lineHeight: 1.7, marginBottom: 14 }}>
              {t('access.gate.desc')}
            </div>
            <button type="button" style={buttonStyle(busy !== null)} disabled={busy !== null} onClick={() => void connect('connect')} data-testid="access-mask-connect">
              {t('access.gate.action')}
            </button>
          </div>
        </div>
      ) : null}

      {/* ── 手动安装弹窗 ── */}
      {manual !== null ? (
        <div style={overlayStyle} onClick={() => setManual(null)}>
          <div style={{ ...modalStyle }} onClick={(event) => event.stopPropagation()} data-testid="access-manual-dialog">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ ...cardTitleStyle, fontSize: 14 }}>
                {t('access.manual.title', {
                  host: plans?.labels[manual.host] ?? manual.host,
                  kind: t(manual.kind === 'hook' ? 'access.manual.kind.hook' : 'access.manual.kind.mcp'),
                })}
              </div>
              <button type="button" style={linkButtonStyle} onClick={() => setManual(null)}>
                {t('common.close')}
              </button>
            </div>
            <pre style={preStyle} data-testid="access-manual-text">
              {t(manualTextKey(manual.host, manual.kind))}
            </pre>
          </div>
        </div>
      ) : null}

      {/* ── 二次确认弹窗：列出将写入哪些文件 ── */}
      {confirming !== null ? (
        <div style={overlayStyle} onClick={() => setConfirming(null)}>
          <div style={{ ...modalStyle }} onClick={(event) => event.stopPropagation()} data-testid="access-confirm-dialog">
            <div style={{ ...cardTitleStyle, fontSize: 14 }}>{t('access.confirm.title', { host: plans?.labels[confirming.host] ?? confirming.host })}</div>
            <div style={{ ...mutedStyle, lineHeight: 1.7, marginBottom: 8 }}>{t('access.confirm.desc')}</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.8 }}>
              {confirming.steps.map((step) => (
                <li key={`${step.action}:${step.path}`}>
                  <span style={mutedStyle}>{actionText(step.action)} </span>
                  <code style={{ fontSize: 11 }}>{step.path}</code>
                  {step.note === undefined ? null : (
                    <span style={mutedStyle}>{t('common.paren', { text: noteText(step.note) ?? '' })}</span>
                  )}
                </li>
              ))}
            </ul>
            {confirming.risk !== null ? <div style={{ ...mutedStyle, marginTop: 8 }}>{t('access.confirm.risk', { risk: riskText(confirming.risk) })}</div> : null}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
              <button type="button" style={buttonStyle(busy !== null)} disabled={busy !== null} onClick={() => setConfirming(null)}>
                {t('access.confirm.cancel')}
              </button>
              <button type="button" style={buttonStyle(busy !== null)} disabled={busy !== null} onClick={() => void runInstall(confirming)} data-testid="access-confirm-install">
                {t('access.confirm.ok')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 90,
  background: 'rgba(8, 12, 18, 0.72)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const modalStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-strong, #3a4a5a)',
  borderRadius: 8,
  padding: '16px 18px',
  minWidth: 420,
  maxWidth: 620,
  maxHeight: '70vh',
  overflow: 'auto',
};

const preStyle: CSSProperties = {
  margin: '10px 0 0',
  padding: '10px 12px',
  borderRadius: 6,
  background: 'var(--color-bg-base)',
  color: 'var(--color-text-secondary)',
  fontSize: 11,
  lineHeight: 1.7,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};
