/**
 * 首启入驻弹窗（Z-01C-h / 设计 §16.4）。
 *
 * 触发条件全在服务端算（`GET /hook/api/onboard` 的 `should_prompt`）：
 * 「没弹过」且「至少探测到一个宿主」——探测不到就没什么可勾的，弹了只是打扰。
 *
 * 三段式（§16.4）：
 *   ① 勾选：Hook 插件（Magpie 可装，Claude Code / DSH 显示但禁用）+ MCP（只显示）
 *   ② 二次确认：列出将写入的文件，用户点「确认安装」才真写
 *   ③ 装完跳 `/ui/hook?from=onboard&result=ok|fail`：成功失败都用接入页显示结果
 *
 * 关掉 = 已触发：落 `dialog_shown:true` + `dialog_closed_at`，不再弹（§16.2）。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { resolveToken } from '../api.js';
import { navigate } from './navigate.js';
import { useT } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';
import {
  actionText,
  reasonText,
  riskText,
  type HookHost,
  type PlanPayload,
} from '../access/plan.js';

interface HostDetection {
  hit: boolean;
  via: readonly string[];
}

interface OnboardPayload {
  should_prompt: boolean;
  detected: { at: string; hosts: Record<HookHost, HostDetection> } | null;
  labels: Record<HookHost, string>;
  installs: Record<string, { state: string; at: string | null }>;
}

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

const VIA_KEYS: Record<string, DictKey> = {
  dir: 'onboard.via.dir',
  port: 'onboard.via.port',
  process: 'onboard.via.process',
};

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 100,
  background: 'rgba(8, 12, 18, 0.78)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const modalStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-strong, #3a4a5a)',
  borderRadius: 14,
  padding: '20px 22px',
  width: 560,
  maxWidth: '86vw',
  maxHeight: '80vh',
  overflow: 'auto',
  boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
};

const titleStyle: CSSProperties = {
  color: 'var(--color-text-primary)',
  fontSize: 16,
  fontWeight: 600,
  margin: 0,
};

const mutedStyle: CSSProperties = {
  color: 'var(--color-text-faint)',
  fontSize: 12,
  lineHeight: 1.7,
};

const groupStyle: CSSProperties = {
  borderTop: '1px solid var(--color-border-subtle)',
  marginTop: 12,
  paddingTop: 10,
};

function buttonStyle(primary = false, disabled = false): CSSProperties {
  return {
    padding: '7px 16px',
    borderRadius: 8,
    border: primary ? '1px solid transparent' : '1px solid var(--color-border-subtle)',
    background: primary ? 'var(--color-accent, #4a9eff)' : 'transparent',
    color: primary ? '#fff' : disabled ? 'var(--color-text-faint)' : 'var(--color-text-primary)',
    fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

type Phase = 'hidden' | 'pick' | 'confirm';

export interface OnboardModalProps {
  /** 弹窗开合变化：外壳据此抑制首屏提示条（弹窗里已经在做同一件事，两条并排太吵） */
  onOpenChange?: (open: boolean) => void;
}

export function OnboardModal({ onOpenChange }: OnboardModalProps = {}): ReactElement | null {
  const t = useT();
  const [phase, setPhase] = useState<Phase>('hidden');
  const [onboard, setOnboard] = useState<OnboardPayload | null>(null);
  const [plans, setPlans] = useState<PlanPayload | null>(null);
  /** 勾选的安装项（key = `host:kind`） */
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const askedRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const [ob, plan] = await Promise.all([
      api<OnboardPayload>('/hook/api/onboard', { method: 'POST', body: { open: true } }),
      api<PlanPayload>('/hook/api/install/plan'),
    ]);
    setOnboard(ob);
    setPlans(plan);
    if (ob.should_prompt) {
      setPhase((current) => (current === 'hidden' ? 'pick' : current));
      // 默认勾上唯一能装的项，用户不用多点一次
      setSelected((current) =>
        current.length > 0
          ? current
          : plan.plans
              .filter((p) => p.supported && p.host === 'magpie' && p.kind === 'hook')
              .map((p) => `${p.host}:${p.kind}`),
      );
    }
  }, []);

  useEffect(() => {
    if (askedRef.current) return;
    askedRef.current = true;
    void load().catch(() => undefined);
  }, [load]);

  // 开合上报放在 phase 之后：只在真正显示/关闭时通知一次
  useEffect(() => {
    onOpenChange?.(phase !== 'hidden');
  }, [phase, onOpenChange]);

  const close = async (): Promise<void> => {
    setPhase('hidden');
    try {
      await api('/hook/api/onboard', {
        method: 'POST',
        body: { dialog_shown: true, dialog_closed_at: new Date().toISOString() },
      });
    } catch {
      // 落盘失败不挡用户：下次打开再弹一次比卡住强
    }
  };

  const redetect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api('/hook/api/detect?refresh=1', { method: 'POST', body: {} });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const installAndJump = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    let ok = true;
    try {
      for (const key of selected) {
        const [host, kind] = key.split(':');
        if (host === undefined || kind === undefined) continue;
        const res = await api<{ ok: boolean }>('/hook/api/install', {
          method: 'POST',
          body: { host, kind, confirm: true },
        });
        ok = ok && res.ok;
      }
    } catch (err) {
      ok = false;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
    // 无论成败都去接入页：结果、手动安装、台账都在那儿（§16.4 第 4 步）
    await close();
    const token = new URLSearchParams(window.location.search).get('token');
    const query = `from=onboard&result=${ok ? 'ok' : 'fail'}${token === null ? '' : `&token=${encodeURIComponent(token)}`}`;
    navigate(`/ui/hook?${query}`);
  };

  if (phase === 'hidden') return null;

  const hookPlans = (plans?.plans ?? []).filter((plan) => plan.kind === 'hook');
  const mcpPlans = (plans?.plans ?? []).filter((plan) => plan.kind === 'mcp');
  const confirmPlans = (plans?.plans ?? []).filter((plan) => selected.includes(`${plan.host}:${plan.kind}`));

  return (
    <div style={overlayStyle} data-testid="onboard-modal" data-phase={phase}>
      <div style={modalStyle}>
        {phase === 'pick' ? (
          <>
            <h3 style={titleStyle}>{t('onboard.title')}</h3>
            <div style={{ ...mutedStyle, marginTop: 6 }}>
              {t('onboard.intro')}
            </div>

            <div style={groupStyle}>
              <div style={{ fontSize: 13, color: 'var(--color-text-primary)', marginBottom: 6 }}>{t('onboard.group.hook')}</div>
              {hookPlans.map((plan) => {
                const key = `${plan.host}:${plan.kind}`;
                const detection = onboard?.detected?.hosts[plan.host];
                const hit = detection?.hit === true;
                const unusable = !plan.supported;
                const checked = selected.includes(key);
                return (
                  <label
                    key={key}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', cursor: unusable ? 'not-allowed' : 'pointer' }}
                    data-testid={`onboard-check-${key}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={unusable || busy}
                      onChange={(event) => {
                        setSelected((current) =>
                          event.target.checked ? [...current, key] : current.filter((k) => k !== key),
                        );
                      }}
                    />
                    <span style={{ flex: 1 }}>
                      <span style={{ fontSize: 13, color: unusable ? 'var(--color-text-faint)' : 'var(--color-text-primary)' }}>
                        {plans?.labels[plan.host] ?? plan.host}
                      </span>
                      <span style={{ ...mutedStyle, marginLeft: 8 }}>
                        {hit
                          ? t('onboard.detected', {
                              via: (detection?.via ?? [])
                                .map((via) => (VIA_KEYS[via] === undefined ? via : t(VIA_KEYS[via] as DictKey)))
                                .join(t('common.listSep')),
                            })
                          : t('onboard.notDetected')}
                        {unusable ? t('onboard.unsupported', { reason: reasonText(plan.reason) }) : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>

            <div style={groupStyle}>
              <div style={{ fontSize: 13, color: 'var(--color-text-primary)', marginBottom: 6 }}>{t('onboard.group.mcp')}</div>
              {mcpPlans.map((plan) => (
                <div key={`${plan.host}:${plan.kind}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }} data-testid={`onboard-mcp-${plan.host}`}>
                  <input type="checkbox" disabled checked={false} />
                  <span style={{ fontSize: 13, color: 'var(--color-text-faint)' }}>{plans?.labels[plan.host] ?? plan.host}</span>
                  <span style={{ ...mutedStyle, marginLeft: 4 }}>{t('onboard.mcpSoon')}</span>
                </div>
              ))}
            </div>

            {error !== null ? <div style={{ ...mutedStyle, color: 'var(--color-status-error, #e05252)', marginTop: 10 }}>{error}</div> : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
              <button type="button" style={buttonStyle(false, busy)} disabled={busy} onClick={() => void redetect()} data-testid="onboard-redetect">
                {t('onboard.redetect')}
              </button>
              <span style={{ flex: 1 }} />
              <button type="button" style={buttonStyle(false, busy)} disabled={busy} onClick={() => void close()} data-testid="onboard-close">
                {t('onboard.later')}
              </button>
              <button
                type="button"
                style={buttonStyle(true, busy || selected.length === 0)}
                disabled={busy || selected.length === 0}
                onClick={() => setPhase('confirm')}
                data-testid="onboard-next"
              >
                {t('onboard.next')}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 style={titleStyle}>{t('onboard.confirm.title')}</h3>
            <div style={{ ...mutedStyle, marginTop: 6 }}>{t('onboard.confirm.intro')}</div>
            {confirmPlans.map((plan) => (
              <div key={`${plan.host}:${plan.kind}`} style={groupStyle}>
                <div style={{ fontSize: 13, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                  {plans?.labels[plan.host] ?? plan.host} ·{' '}
                  {plan.kind === 'hook' ? t('onboard.group.hook') : 'MCP'}
                  {plan.root === null ? null : <span style={mutedStyle}> → {plan.root}</span>}
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.8 }}>
                  {plan.steps.map((step) => (
                    <li key={`${step.action}:${step.path}`}>
                      <span style={mutedStyle}>{actionText(step.action)} </span>
                      <code style={{ fontSize: 11 }}>{step.path}</code>
                    </li>
                  ))}
                </ul>
                {plan.risk !== null ? <div style={{ ...mutedStyle, marginTop: 4 }}>{t('onboard.risk', { risk: riskText(plan.risk) })}</div> : null}
              </div>
            ))}
            {error !== null ? <div style={{ ...mutedStyle, color: 'var(--color-status-error, #e05252)', marginTop: 10 }}>{error}</div> : null}
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <span style={{ flex: 1 }} />
              <button type="button" style={buttonStyle(false, busy)} disabled={busy} onClick={() => setPhase('pick')}>
                {t('onboard.back')}
              </button>
              <button type="button" style={buttonStyle(true, busy)} disabled={busy} onClick={() => void installAndJump()} data-testid="onboard-confirm">
                {busy ? t('onboard.installing') : t('onboard.confirm.ok')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
