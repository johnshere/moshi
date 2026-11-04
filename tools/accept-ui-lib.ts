/**
 * `tools/accept-ui.ts` 的纯函数库（台账 P2-19-B / P2-19 验收口径）。
 *
 * 只放可单测的纯逻辑：帧率中位数、判定（calls / 缺页 / fps 警告）、报告组装、
 * 控制台行格式化。起 Chrome、连 CDP、截图的部分都在 `tools/accept-ui.ts` 里，
 * 保证这一文件可以被 `tests/unit/accept-ui.test.ts` 直接覆盖而不碰文件系统。
 */

/** 五个一级页面（概设 §8.1） */
export const ACCEPT_UI_PAGES = ['graph', 'memories', 'inbox', 'archive', 'settings'] as const;
export type AcceptUiPage = (typeof ACCEPT_UI_PAGES)[number];

export type PageKey = AcceptUiPage;

/** `renderer.info.render.calls` 上限（用户 D-133：`calls ≤ 12`） */
export const MAX_CALLS = 12;
/** 集显口径差异：不做 30fps 硬断言，低于此值只标 warn */
export const FPS_WARN = 30;
/** fps 采样轮数（每轮 1s 的 rAF 计数） */
export const FPS_SAMPLE_ROUNDS = 3;

/** 单页采样结果 */
export interface PageSample {
  page: PageKey;
  path: string;
  title: string;
  /** `/ui/graph` 的 `__moshiGraph.calls`；其它页为 null */
  calls: number | null;
  /** 3 轮 fps 的中位数；无有效样本为 null */
  fps: number | null;
  frame_samples: number[];
  /** 关键选择器是否存在（缺失只记录，不判失败） */
  selectors: Record<string, boolean>;
  /** 截图路径（相对 cwd；失败为 ''） */
  screenshot: string;
  screenshot_ms: number;
}

export interface GraphReadout {
  calls: number | null;
  nodeCount: number | null;
  edgeCount: number | null;
  fps: number | null;
}

export interface ReportIssue {
  page: string;
  reason: string;
}

/** 验收报告（`moshi-accept-ui/1`） */
export interface UiReport {
  schema: 'moshi-accept-ui/1';
  at: string;
  base_url: string;
  facts: number;
  edges: number;
  pages: PageSample[];
  graph: GraphReadout;
  verdict: 'pass' | 'warn' | 'fail';
  violations: ReportIssue[];
  warnings: ReportIssue[];
}

export interface BuildReportInput {
  at: string;
  baseUrl: string;
  facts: number;
  edges: number;
  pages: readonly PageSample[];
  graph: GraphReadout;
}

/** 中位数；空数组/无有限样本 → null（报告用 null 表示「没采到」而不是 0） */
export function medianFps(samples: readonly number[]): number | null {
  const valid = samples.filter((n) => Number.isFinite(n) && n >= 0);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : (((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/**
 * 判定：
 * - 缺页 → fail；
 * - `graph.calls > 12` → fail；
 * - 任一样本 fps < 30 → warn（不做硬失败）。
 * 同一页同时命中 fail 与 warn 时只记 fail。
 */
export function decideVerdict(
  report: Pick<UiReport, 'pages' | 'graph'>,
): { verdict: UiReport['verdict']; violations: ReportIssue[]; warnings: ReportIssue[] } {
  const violations: ReportIssue[] = [];
  const warnings: ReportIssue[] = [];
  const seen = new Set<string>();
  for (const page of ACCEPT_UI_PAGES) {
    if (!report.pages.some((p) => p.page === page)) {
      violations.push({ page, reason: 'page_missing' });
    }
  }
  seen.clear();
  if (report.graph.calls !== null && report.graph.calls > MAX_CALLS) {
    violations.push({
      page: 'graph',
      reason: `calls=${String(report.graph.calls)} > ${String(MAX_CALLS)}`,
    });
    seen.add('graph');
  }
  for (const page of report.pages) {
    if (page.fps !== null && page.fps < FPS_WARN && !seen.has(page.page)) {
      warnings.push({ page: page.page, reason: `fps=${String(page.fps)} < ${String(FPS_WARN)}` });
    }
  }
  if (report.graph.calls === null) {
    violations.push({ page: 'graph', reason: 'calls_missing' });
  }
  if (violations.length > 0) return { verdict: 'fail', violations, warnings };
  return { verdict: warnings.length > 0 ? 'warn' : 'pass', violations, warnings };
}

/** 组装报告；判定结果也一并写进 `verdict/violations/warnings` */
export function buildReport(input: BuildReportInput): UiReport {
  const base = {
    schema: 'moshi-accept-ui/1' as const,
    at: input.at,
    base_url: input.baseUrl,
    facts: input.facts,
    edges: input.edges,
    pages: [...input.pages],
    graph: input.graph,
  };
  const verdict = decideVerdict(base);
  return { ...base, ...verdict };
}

/** 控制台单行：`PASS graph /ui/graph fps=59.9 calls=8 nodes=5000 edges=15000 shot_ms=412` */
export function formatPageLine(page: PageSample, graph: GraphReadout): string {
  const parts = [page.fps !== null && page.fps < FPS_WARN ? 'WARN' : 'PASS', page.page, page.path];
  parts.push(`title=${JSON.stringify(page.title)}`);
  parts.push(`fps=${page.fps === null ? '—' : String(page.fps)}`);
  parts.push(`calls=${page.calls === null ? '—' : String(page.calls)}`);
  if (page.page === 'graph') {
    parts.push(`nodes=${graph.nodeCount === null ? '—' : String(graph.nodeCount)}`);
    parts.push(`edges=${graph.edgeCount === null ? '—' : String(graph.edgeCount)}`);
  }
  parts.push(`shot_ms=${String(page.screenshot_ms)}`);
  return parts.join(' ');
}
