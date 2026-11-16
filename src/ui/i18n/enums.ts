/**
 * 字段值 → 界面文案（D-184）。
 *
 * 后端枚举（`ftype`、`epistemic_status`、日志 `kind` / `status` …）是数据契约，值本身
 * 不能改；界面上也不该裸显示英文值——一律经这里映射。未知值原样返回（新枚举没翻译时
 * 不至于空白，也让「后端多了一个没登记的值」在界面上看得见）。
 */
import { hasKey, t, type DictKey } from './index.js';

/** 枚举域 → 词典键前缀；加域就在这里加一行，词典里补齐 `enum.<域>.<值>` */
const DOMAIN_PREFIX = {
  ftype: 'enum.ftype.',
  epistemic: 'enum.epistemic.',
  logKind: 'enum.logKind.',
  logStatus: 'enum.logStatus.',
  turn: 'enum.turn.',
  outcome: 'enum.outcome.',
  install: 'enum.install.',
  // I-70 / D-187：安装计划的码值（以前服务端直接下发中文句子）
  installAction: 'enum.installAction.',
  installReason: 'enum.installReason.',
  installRisk: 'enum.installRisk.',
} as const satisfies Record<string, string>;

export type EnumDomain = keyof typeof DOMAIN_PREFIX;

export function enumLabel(domain: EnumDomain, value: string): string {
  const key = `${DOMAIN_PREFIX[domain]}${value}`;
  return hasKey(key) ? t(key as DictKey) : value;
}
