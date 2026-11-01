/**
 * `content` 生成（详设 §5.3「content 生成规则」）。
 *
 * 集中在一处而不是每个 parser 自己拼，原因是 `content` 有三个下游用途：
 * 全文检索（`fact_fts`）、UI 列表、证据包渲染。三处口径必须一致，
 * 分散拼装迟早出现"检索得到但列表里读不懂"。
 *
 * 模板优先用中文标签（"node 的安装版本为 22.9.0"），没有登记标签时退回
 * "subject predicate value"——宁可生硬，也不能因为没登记标签就不落库。
 */
import type { FactSubject } from './types.js';

/** 谓词的中文标签；新增谓词时**必须**在这里登记，否则 content 会退化成机器话 */
const PREDICATE_LABEL: Record<string, string> = {
  installed_version: '安装版本',
  runtime_version: '运行时版本',
  version: '版本',
  package_manager: '包管理器',
  git_branch: '当前分支',
  git_sync_state: '与上游的同步状态',
  git_head: 'HEAD 提交',
  occupied_by: '占用进程',
  running: '运行状态',
  port_conflict: '端口冲突',
  exists: '存在性',
  build_result: '构建结果',
  typecheck_result: '类型检查结果',
  test_result: '测试结果',
  env_var: '环境变量',
  container_running: '容器状态',
};

export function predicateLabel(predicate: string): string | undefined {
  return PREDICATE_LABEL[predicate];
}

/** value 的简短形式：字符串原样，对象取前三个键 */
export function describeValue(value: unknown, max = 40): string {
  const raw = (() => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null) return 'null';
    if (Array.isArray(value)) return value.map((v) => describeValue(v, 16)).join(', ');
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).slice(0, 3);
      return entries.map(([k, v]) => `${k}=${describeValue(v, 16)}`).join(', ');
    }
    return String(value);
  })();
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

export function buildContent(subject: FactSubject, predicate: string, value: unknown): string {
  const label = predicateLabel(predicate);
  const v = describeValue(value, 60);
  if (label === undefined) return `${subject.name} ${predicate} ${v}`;
  return `${subject.name} 的${label}为 ${v}`;
}
