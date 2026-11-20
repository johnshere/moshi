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
 *
 * 视觉（w10）：本页只消费 `styles/app.css` 的读数带语言——页头是台账头，四段主体
 * 是 `.band`（1px 边 + 四角准星），矩阵/台账是读数行，浮层用 `.modal` 的准星组。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
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
    <div className={standalone ? 'ledger ledger-fill' : 'station-stack'} data-testid="access-page">
      {standalone ? (
        <header className="ledger-head">
          <div className="ledger-title">{t('access.title')}</div>
          <div className="ledger-tools">
            <a className="btn btn-quiet" href={`/ui/graph${window.location.search}`} data-testid="access-back">
              {t('access.back')}
            </a>
          </div>
        </header>
      ) : null}

      <div className={standalone ? 'station-body' : 'station-stack'}>
        <p className="station-note">{t('access.intro')}</p>

        {resultText !== null ? (
          <div className="notice" data-tone={resultTone === 'ok' ? 'ok' : 'error'} data-testid="access-result">
            <span className="notice-text">{resultText}</span>
            <button type="button" className="chip chip-action" onClick={() => setResultText(null)}>
              {t('common.close')}
            </button>
          </div>
        ) : null}

        {error !== null ? (
          <div className="notice" data-tone="error" data-testid="access-error">
            <span className="notice-text">{error}</span>
          </div>
        ) : null}

        {/* ── 连接态 + 工程身份 ── */}
        <section className="band" data-testid="access-connection">
          <div className="band-head">
            <span className="band-title">{t('access.conn.title')}</span>
            <span
              className={`readout-status ${connected ? 'tone-ok' : 'tone-faint'}`}
              data-testid="access-connected"
              data-connected={connected ? 'true' : 'false'}
            >
              <i className="lamp" aria-hidden="true" />
              {connected ? t('access.conn.connected') : t('access.conn.disconnected')}
            </span>
            <div className="band-tools">
              <button
                type="button"
                className={connected ? 'btn' : 'btn btn-primary'}
                data-testid="access-connect-toggle"
                disabled={busy !== null}
                onClick={() => void connect(connected ? 'disconnect' : 'connect')}
              >
                {connected ? t('access.conn.disconnect') : t('access.conn.connect')}
              </button>
            </div>
          </div>
          <div className="band-body">
            <span className="station-note">{t('access.conn.hint')}</span>
          </div>
        </section>

        {/* ── 三个真开关（magpie_enabled 由连接按钮驱动，不单独给开关，避免两处语义打架） ── */}
        <section className="band" data-testid="access-switches">
          <div className="band-head">
            <span className="band-title">{t('access.switches.title')}</span>
          </div>
          <div className="band-body">
            {(
              [
                ['enabled', 'access.switch.enabled.label', 'access.switch.enabled.desc'],
                ['inject_existing', 'access.switch.inject_existing.label', 'access.switch.inject_existing.desc'],
                ['capture_reply', 'access.switch.capture_reply.label', 'access.switch.capture_reply.desc'],
              ] as const
            ).map(([key, labelKey, hintKey]) => (
              <label key={key} className="switch" data-testid={`access-switch-${key}`}>
                <input
                  type="checkbox"
                  checked={status?.switches[key] === true}
                  disabled={status === null || busy !== null}
                  onChange={(event) => void setSwitch({ [key]: event.target.checked })}
                />
                <span className="switch-body">
                  <span className="switch-label">{t(labelKey)}</span>
                  <span className="switch-hint">{t(hintKey)}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* ── 接入矩阵：两大类 × 三个客户端 ── */}
        {(['hook', 'mcp'] as const).map((kind) => (
          <section className="band" key={kind} data-testid={`access-group-${kind}`}>
            <div className="band-head">
              <span className="band-title">{t(kind === 'hook' ? 'access.matrix.hook' : 'access.matrix.mcp')}</span>
              {kind === 'mcp' ? <span className="band-tag">{t('access.matrix.note')}</span> : null}
            </div>
            <div className="band-body">
              {(plans?.plans ?? [])
                .filter((plan) => plan.kind === kind)
                .map((plan) => {
                  const record = recordOf(plan);
                  const installed = record?.state === 'installed';
                  const detected = onboard?.detected?.hosts[plan.host]?.hit === true;
                  const label = plans?.labels[plan.host] ?? plan.host;
                  const isMagpieHook = plan.host === 'magpie' && plan.kind === 'hook';
                  return (
                    <div key={`${plan.host}:${plan.kind}`} className="matrix-row" data-testid={`access-plan-${plan.host}-${plan.kind}`}>
                      <span className="matrix-name">
                        {label}
                        {detected ? <span className="readout tone-accent">{t('access.matrix.detected')}</span> : null}
                      </span>
                      <span
                        className={`readout-status matrix-state ${installed ? 'tone-ok' : plan.supported ? 'tone-mute' : 'tone-faint'}`}
                        data-testid={`access-state-${plan.host}-${plan.kind}`}
                        data-state={installed ? 'installed' : plan.supported ? 'absent' : 'unsupported'}
                      >
                        <i className="lamp" aria-hidden="true" />
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
                      <span className="matrix-actions">
                        {isMagpieHook ? (
                          installed ? (
                            <button
                              type="button"
                              className="btn"
                              disabled={busy !== null}
                              data-testid="access-uninstall"
                              onClick={() => void runUninstall(plan)}
                            >
                              {t('access.matrix.uninstall')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn"
                              disabled={busy !== null}
                              data-testid="access-install"
                              onClick={() => setConfirming(plan)}
                            >
                              {t('access.matrix.install')}
                            </button>
                          )
                        ) : (
                          <button type="button" className="btn" disabled data-testid={`access-soon-${plan.host}-${plan.kind}`}>
                            {t('access.matrix.soon')}
                          </button>
                        )}
                        <button
                          type="button"
                          className="chip chip-action"
                          data-testid={`access-manual-${plan.host}-${plan.kind}`}
                          onClick={() => setManual({ host: plan.host, kind: plan.kind })}
                        >
                          {t('access.matrix.manual')}
                        </button>
                      </span>
                    </div>
                  );
                })}
            </div>
          </section>
        ))}

        {/* ── 注入台账 ── */}
        <section className="band" data-testid="access-trace">
          <div className="band-head">
            <span className="band-title">{t('access.trace.title')}</span>
            <span className="band-tag">
              {t('access.trace.meta', { n: trace?.items.length ?? 0, capacity: trace?.capacity ?? 0 })}
            </span>
            <div className="band-tools">
              <button
                type="button"
                className="btn"
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
          </div>
          <div className="band-body">
            <div className="data-scroll">
              <div className="data-table">
                <div className="data-head cols-trace">
                  <span>{t('access.trace.col.time')}</span>
                  <span>{t('access.trace.col.turn')}</span>
                  <span>{t('access.trace.col.outcome')}</span>
                  <span>{t('access.trace.col.evidence')}</span>
                  <span data-num="true">{t('access.trace.col.bytes')}</span>
                  <span data-num="true">{t('access.trace.col.latency')}</span>
                </div>
                {(trace?.items ?? []).map((item, index) => (
                  <div key={`${item.ts}:${String(index)}`} className="data-row cols-trace">
                    <span className="data-num data-line">{item.ts.slice(11, 19)}</span>
                    <span>{enumLabel('turn', item.turn)}</span>
                    <span>
                      {enumLabel('outcome', item.status)}
                      {item.degraded.length > 0 ? (
                        <span className="tone-faint">{t('common.paren', { text: item.degraded.join('/') })}</span>
                      ) : null}
                    </span>
                    <span>{item.evidence}</span>
                    <span className="data-num">{item.inject_bytes}</span>
                    <span className="data-num">{item.latency_ms}ms</span>
                  </div>
                ))}
                {trace !== null && trace.items.length === 0 ? (
                  <div className="data-empty">{t('access.trace.empty')}</div>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ── F8 遮罩：断开过 Magpie 的情况下先要求连接，避免用户以为插件坏了 ──
          刚从首启弹窗装完跳过来时不遮：此刻要让用户先看到安装结果（结果条就在上面），
          连接按钮在「连接」卡片里，跑不掉。 */}
      {needsConnect && onboardResult === null ? (
        <div className="overlay-gate" data-testid="access-mask">
          <div className="band gate-card">
            <div className="band-body">
              <h3 className="gate-title">{t('access.gate.title')}</h3>
              <p className="station-note gate-note">{t('access.gate.desc')}</p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null}
                onClick={() => void connect('connect')}
                data-testid="access-mask-connect"
              >
                {t('access.gate.action')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── 手动安装弹窗 ── */}
      {manual !== null ? (
        <div className="modal-backdrop" onClick={() => setManual(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()} data-testid="access-manual-dialog">
            <div className="modal-head">
              <div className="modal-head-body">
                <h3 className="modal-title">
                  {t('access.manual.title', {
                    host: plans?.labels[manual.host] ?? manual.host,
                    kind: t(manual.kind === 'hook' ? 'access.manual.kind.hook' : 'access.manual.kind.mcp'),
                  })}
                </h3>
              </div>
              <button type="button" className="chip chip-action" onClick={() => setManual(null)}>
                {t('common.close')}
              </button>
            </div>
            <pre className="dialog-pre" data-testid="access-manual-text">
              {t(manualTextKey(manual.host, manual.kind))}
            </pre>
          </div>
        </div>
      ) : null}

      {/* ── 二次确认弹窗：列出将写入哪些文件 ── */}
      {confirming !== null ? (
        <div className="modal-backdrop" onClick={() => setConfirming(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()} data-testid="access-confirm-dialog">
            <div className="modal-head">
              <div className="modal-head-body">
                <h3 className="modal-title">
                  {t('access.confirm.title', { host: plans?.labels[confirming.host] ?? confirming.host })}
                </h3>
              </div>
            </div>
            <p className="station-note">{t('access.confirm.desc')}</p>
            <ul className="confirm-steps">
              {confirming.steps.map((step) => (
                <li key={`${step.action}:${step.path}`}>
                  <span className="tone-mute">{actionText(step.action)} </span>
                  <code className="confirm-path">{step.path}</code>
                  {step.note === undefined ? null : (
                    <span className="tone-faint">{t('common.paren', { text: noteText(step.note) ?? '' })}</span>
                  )}
                </li>
              ))}
            </ul>
            {confirming.risk !== null ? (
              <p className="station-note">{t('access.confirm.risk', { risk: riskText(confirming.risk) })}</p>
            ) : null}
            <div className="modal-actions">
              <button type="button" className="btn" disabled={busy !== null} onClick={() => setConfirming(null)}>
                {t('access.confirm.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null}
                onClick={() => void runInstall(confirming)}
                data-testid="access-confirm-install"
              >
                {t('access.confirm.ok')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
