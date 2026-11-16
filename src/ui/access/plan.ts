/**
 * 安装计划的**线上契约 + 文案映射**（I-70 / D-187）。
 *
 * 边界（D-184）：服务端只下发**码值 + 数据**（`action` / `reason` / `risk` / `note.code` /
 * 路径 / spec），句子一律在界面按当前语言拼。这样同一条计划在中英文下各说各的话，
 * 服务端不需要知道界面语言。
 *
 * 两个消费方（`access/AccessPage.tsx` 的确认弹窗、`shell/OnboardModal.tsx` 的首启弹窗）
 * 共用这里的类型与映射函数——以前两处各写一份镜像接口，改契约要改两遍。
 *
 * 未知码一律**原样返回**（`enumLabel` 的兜底）：后端加了新码而界面还没翻译时，
 * 用户看到的是码而不是空白；`onboarding.json` 里上一版存下的中文原因也照样显示。
 */
import { t, type DictKey } from '../i18n/index.js';
import { enumLabel } from '../i18n/enums.js';

export type HookHost = 'magpie' | 'claude-code' | 'dsh';

/** 计划里的动作码（`enum.installAction.*`） */
export type InstallAction = 'add' | 'update' | 'remove';

/** 不可安装的原因码（`enum.installReason.*`） */
export type InstallReasonCode =
  | 'plugin_dir_missing'
  | 'package_missing'
  | 'hook_emit_missing'
  | 'host_plugin_missing'
  | 'mcp_not_implemented'
  | 'nothing_to_uninstall';

/** 已知不确定性码（`enum.installRisk.*`） */
export type InstallRiskCode = 'reload_plugin_host';

/** 一条动作的附注：码 + 数据，句子由界面拼 */
export type InstallStepNote =
  | { code: 'from_package'; file: string }
  | { code: 'registry_present' }
  | { code: 'registry_add'; spec: string };

export interface InstallStep {
  action: InstallAction;
  path: string;
  note?: InstallStepNote;
}

export interface InstallPlan {
  host: HookHost;
  kind: 'hook' | 'mcp';
  supported: boolean;
  reason: InstallReasonCode | string | null;
  root: string | null;
  version: string | null;
  steps: readonly InstallStep[];
  risk: InstallRiskCode | string | null;
}

export interface PlanPayload {
  plans: readonly InstallPlan[];
  labels: Record<HookHost, string>;
  keys: readonly { host: HookHost; kind: 'hook' | 'mcp'; key: string }[];
}

/** 动作码 → 文案（未知值原样） */
export function actionText(action: string): string {
  return enumLabel('installAction', action);
}

/** 原因码 → 文案；`null` 给空串（调用方决定要不要回退到「未知原因」） */
export function reasonText(reason: string | null | undefined): string {
  if (reason === null || reason === undefined || reason === '') return '';
  return enumLabel('installReason', reason);
}

/** 风险码 → 整句；`null` 给空串（调用方本来就有 `!== null` 守卫） */
export function riskText(risk: string | null | undefined): string {
  if (risk === null || risk === undefined || risk === '') return '';
  return enumLabel('installRisk', risk);
}

/** 步骤附注：码 + 数据拼句；字符串（旧版本下发值）原样 */
export function noteText(note: InstallStepNote | string | undefined): string | null {
  if (note === undefined) return null;
  if (typeof note === 'string') return note;
  if (note.code === 'from_package') return t('access.note.fromPackage', { file: note.file });
  if (note.code === 'registry_present') return t('access.note.registryPresent');
  if (note.code === 'registry_add') return t('access.note.registryAdd', { spec: note.spec });
  return null;
}

/** 手动安装文案的词典键（文案正本在词典里，服务端不再下发；D-187） */
const MANUAL_TEXT_KEYS: Readonly<Record<'hook' | 'mcp', Readonly<Record<HookHost, DictKey>>>> = {
  hook: {
    magpie: 'access.manualText.hook.magpie',
    'claude-code': 'access.manualText.hook.claudeCode',
    dsh: 'access.manualText.hook.dsh',
  },
  mcp: {
    magpie: 'access.manualText.mcp.magpie',
    'claude-code': 'access.manualText.mcp.claudeCode',
    dsh: 'access.manualText.mcp.dsh',
  },
};

export function manualTextKey(host: HookHost, kind: 'hook' | 'mcp'): DictKey {
  return MANUAL_TEXT_KEYS[kind][host];
}
