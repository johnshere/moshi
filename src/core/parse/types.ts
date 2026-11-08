/**
 * 解析器的公共形状（详设 §5.3）。
 *
 * 为什么 `match` 和 `extract` 分开：`match` 只回答"这条 turn 值不值得细看"，
 * 它要足够便宜（几百条 turn 里绝大多数匹配不上）；`extract` 才做真正的工作。
 * 合成一个方法会让"匹配上但抽不出东西"这种正常情况变得无法表达。
 */
import type {
  ConfSource,
  EntityType,
  Ftype,
  RetentionClass,
  Volatility,
  AdmissionReason,
  SourceKind,
  RecheckKind,
} from '../../domain/enums.js';

/** 一条待解析的"回合"：一条命令 + 它的输出。适配器（§5.2）产出这个形状 */
export interface RawTurn {
  /** 工具名，如 `Bash` / `shell` / `exec`；大小写不敏感 */
  tool: string;
  /** 命令行原文 */
  cmd: string;
  /** stdout + stderr 合并后的文本 */
  output: string;
  /** 退出码；适配器拿不到时为 null（不等于 0） */
  exitCode: number | null;
  /** 命令执行目录；没有就留空——git / fs 类事实靠它确定主体 */
  cwd?: string;
  ts?: string;
}

export interface FactSubject {
  /** 原文主体名，如 `Node.js` / `8080` / `/usr/bin/node`；规范化交给 resolve */
  name: string;
  type: EntityType;
}

export interface ExtractedFact {
  content: string;
  subject: FactSubject;
  predicate: string;
  value: unknown;
  /** 先验（§5.8 表）；parser 自己最清楚这条抽得多准 */
  confidence: number;
  ftype: Ftype;
  /** V-05 分层属性；parser 最清楚这条观测值不值得留 */
  retentionClass?: RetentionClass;
  volatility?: Volatility;
  admissionReason?: AdmissionReason;
  ttlSeconds?: number | null;
  sourceKind?: SourceKind;
  recheckKind?: RecheckKind;
  expiredAt?: string | null;
  /** 默认 `tool_obs`；`derived` / `procedure` 由巩固任务产出，parser 不用 */
  confidenceSource?: ConfSource;
  importance?: number;
  /** 落进 `attrs.ext`：`{tool, argv, raw_excerpt}` */
  ext?: Record<string, unknown>;
}

export interface Parser {
  /** 稳定 id，如 `pkg.npm`；写进日志与 `ext.parser`，出问题能定位到具体规则 */
  readonly id: string;
  /** 匹配的工具名；空数组 = 所有工具 */
  readonly tools: readonly string[];
  match(turn: RawTurn): boolean;
  extract(turn: RawTurn): ExtractedFact[];
}
