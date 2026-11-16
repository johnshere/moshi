import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataPaths, expandHome, loadConfig, resolveSources } from '../../src/app/config.js';
import { EMBED_DIM, EMBED_MODEL } from '../../src/domain/embedding.js';
import { isMoshiError } from '../../src/domain/errors.js';

const HOME = path.join(tmpdir(), 'moshi-home-test');

function withYaml(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-cfg-'));
  const file = path.join(dir, 'config.yaml');
  writeFileSync(file, content, 'utf8');
  return file;
}

function expectConfigError(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(isMoshiError(err)).toBe(true);
    const e = err as { code: string; message: string };
    expect(e.code).toBe('E_CONFIG');
    return e.message;
  }
  throw new Error('expected E_CONFIG, but nothing was thrown');
}

describe('配置加载（详设 §3.6）', () => {
  it('文件不存在时全部走默认值', () => {
    const cfg = loadConfig({ file: path.join(tmpdir(), 'nope', 'config.yaml'), home: HOME });
    expect(cfg.server.port).toBe(9836);
    expect(cfg.model.gat_mode).toBe('off');
    expect(cfg.retrieval.rrf_k).toBe(60);
    expect(cfg.ingest.sources).toEqual(['claude-code', 'dsh']);
  });

  it('拼错的键启动失败，且错误信息指出键名', () => {
    const file = withYaml('server:\n  prot: 53001\n');
    const msg = expectConfigError(() => loadConfig({ file, home: HOME }));
    expect(msg).toContain('server.prot');
    expect(msg).toContain('未知配置键');
  });

  it('未知 section 同样拒绝', () => {
    const file = withYaml('retreival:\n  vector_topk: 5\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('retreival');
  });

  it('只写要改的键，其余用默认值', () => {
    const file = withYaml('retrieval:\n  vector_topk: 5\n');
    const cfg = loadConfig({ file, home: HOME });
    expect(cfg.retrieval.vector_topk).toBe(5);
    expect(cfg.retrieval.bm25_topk).toBe(20);
    expect(cfg.packing.token_budget).toBe(1500);
  });

  it('~ 展开为绝对路径，且不碰非路径键', () => {
    const file = withYaml('storage:\n  data_dir: "~/data-moshi"\n');
    const cfg = loadConfig({ file, home: HOME });
    expect(cfg.storage.data_dir).toBe(path.resolve(HOME, 'data-moshi'));
    expect(cfg.model.embed_model).toBe(EMBED_MODEL);
    expect(cfg.model.embed_dim).toBe(EMBED_DIM);
  });

  it('expandHome 处理裸 ~ 与绝对路径', () => {
    expect(expandHome('~', HOME)).toBe(HOME);
    expect(expandHome('~/a/b', HOME)).toBe(path.resolve(HOME, 'a/b'));
    expect(expandHome('/abs/x', HOME)).toBe(path.resolve('/abs/x'));
  });

  it('非回环 host 拒绝启动', () => {
    const file = withYaml('server:\n  host: "0.0.0.0"\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('回环');
  });

  it('废弃的 port_scan_max 仍可解析（旧配置兼容）', () => {
    const file = withYaml('server:\n  port: 12000\n  port_scan_max: 53020\n');
    expect(loadConfig({ file, home: HOME }).server.port).toBe(12000);
  });

  it('概率越界被 zod 拦下', () => {
    const file = withYaml('packing:\n  utility_ratio: 1.5\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('packing.utility_ratio');
  });

  it('gat_mode 只接受三档', () => {
    const file = withYaml('model:\n  gat_mode: "maybe"\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('model.gat_mode');
  });

  it('hook_plugin_trace 段默认关，档位只接受三档（Z-01C-e / P1 改名）', () => {
    const defaults = loadConfig({ file: path.join(tmpdir(), 'nope', 'c.yaml'), home: HOME });
    expect(defaults.hook_plugin_trace.level).toBe('off');
    const file = withYaml('hook_plugin_trace:\n  level: "verbose"\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('hook_plugin_trace.level');
  });

  it('非法 YAML 报 E_CONFIG 而不是抛原生异常', () => {
    const file = withYaml('server:\n  port: 1\n  bad: [unclosed\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('YAML');
  });

  it('示例配置能被完整解析（防止 config.example.yaml 与 schema 漂移）', () => {
    const example = path.resolve(import.meta.dirname, '../../config.example.yaml');
    const cfg = loadConfig({ file: example, home: HOME });
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.storage.backup_keep).toBe(7);
    expect(cfg.sidecar.score_timeout_ms).toBe(120);
    expect(cfg.archive.include_raw).toBe(false);
    expect(cfg.ui.theme).toBe('system');
    expect(cfg.log.keep_days).toBe(7);
    expect(cfg.hook_plugin_trace.level).toBe('off');
    expect(cfg.hook_plugin_trace.keep_days).toBe(14);
    // P2-23：直写闸门默认必须关着——示例配置哪天写错了，这条会先炸
    expect(cfg.mcp.allow_direct_write).toBe(false);
    expect(cfg.mcp.direct_write_batch_max).toBe(50);
    expect(cfg.mcp.direct_write_per_minute_max).toBe(120);
    // P2-01 布局：默认值就是详设 §10.4 的数字，示例文件不许单独漂移
    expect(cfg.layout.enabled).toBe(true);
    expect(cfg.layout.tick_full).toBe(300);
    expect(cfg.layout.tick_incremental).toBe(60);
    expect(cfg.layout.link_strength).toBe(0.3);
    expect(cfg.layout.charge_strength).toBe(-30);
    expect(cfg.layout.center_strength).toBe(0.02);
    expect(cfg.layout.community_strength).toBe(0.15);
    expect(cfg.layout.jitter_radius).toBe(5);
    expect(cfg.layout.extent).toBe(100);
    expect(cfg.layout.displacement_threshold).toBe(15);
  });

  it('dataPaths 落在 data_dir 之下', () => {
    const cfg = loadConfig({ file: path.join(tmpdir(), 'x', 'y.yaml'), home: HOME });
    const p = dataPaths(cfg);
    expect(p.db.startsWith(cfg.storage.data_dir)).toBe(true);
    expect(p.db.endsWith('moshi.db')).toBe(true);
    expect(p.lock.endsWith('daemon.lock')).toBe(true);
  });

  it('dataPaths.goldenDir 跟着 eval.golden_set 走（默认跟随 data_dir）', () => {
    const cfg = loadConfig({ file: path.join(tmpdir(), 'nope', 'golden.yaml'), home: HOME });
    const p = dataPaths(cfg);
    // 没显式配 eval.golden_set → 跟着 data_dir，换库不会把 golden 留在真实 home
    expect(cfg.eval.golden_set).toBe(path.join(cfg.storage.data_dir, 'golden', 'golden.jsonl'));
    expect(p.goldenDir).toBe(path.join(cfg.storage.data_dir, 'golden'));
  });

  it('显式 eval.golden_set 不被 data_dir 覆盖', () => {
    const file = withYaml(
      'storage:\n  data_dir: "/data-x"\neval:\n  golden_set: "/elsewhere/golden.jsonl"\n',
    );
    const cfg = loadConfig({ file, home: HOME });
    expect(cfg.eval.golden_set).toBe(path.resolve('/elsewhere/golden.jsonl'));
    expect(dataPaths(cfg).goldenDir).toBe(path.resolve('/elsewhere'));
  });
});

describe('resolveSources（P3-A8 source 实例）', () => {
  it('旧字符串写法：id=adapter，claude-code / dsh 各用默认根', () => {
    const cfg = loadConfig({ file: path.join(tmpdir(), 'nope', 'a.yaml'), home: HOME });
    expect(resolveSources(cfg, HOME)).toEqual([
      {
        id: 'claude-code',
        adapter: 'claude-code',
        root: path.join(HOME, '.claude', 'projects'),
        enabled: true,
      },
      {
        id: 'dsh',
        adapter: 'dsh',
        root: path.join(HOME, '.dsh', 'sessions'),
        enabled: true,
      },
    ]);
  });

  it('旧字符串里的 generic-jsonl 根 = <data_dir>/inbox', () => {
    const file = withYaml('storage:\n  data_dir: "/data-legacy"\ningest:\n  sources: ["claude-code", "generic-jsonl"]\n');
    const cfg = loadConfig({ file, home: HOME });
    const list = resolveSources(cfg, HOME);
    expect(list.map((s) => s.id)).toEqual(['claude-code', 'generic-jsonl']);
    expect(list[1]!.adapter).toBe('generic-jsonl');
    expect(list[1]!.root).toBe(path.join(path.resolve('/data-legacy'), 'inbox'));
  });

  it('ingest.sources 实例：自定义 id/root，enabled=false 被过滤', () => {
    const file = withYaml(
      [
        'storage:',
        '  data_dir: "/data-x"',
        '',
        'ingest:',
        '  sources:',
        '    - id: "work"',
        '      adapter: "claude-code"',
        '      root: "~/work-projects"',
        '    - id: "old"',
        '      adapter: "claude-code"',
        '      root: "/tmp/old"',
        '      enabled: false',
        '    - id: "inbox"',
        '      adapter: "generic-jsonl"',
        '      root: "/tmp/inbox"',
        '      field_map: { text: "message" }',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig({ file, home: HOME });
    const list = resolveSources(cfg, HOME);
    expect(list.map((s) => s.id)).toEqual(['work', 'inbox']);
    expect(list[0]!.root).toBe(path.join(HOME, 'work-projects'));
    expect(list[1]!.fieldMap).toEqual({ text: 'message' });
  });

  it('重复 id 在加载期报 E_CONFIG', () => {
    const file = withYaml(
      [
        'ingest:',
        '  sources:',
        '    - id: "same"',
        '      adapter: "claude-code"',
        '      root: "/tmp/a"',
        '    - id: "same"',
        '      adapter: "claude-code"',
        '      root: "/tmp/b"',
        '',
      ].join('\n'),
    );
    const msg = expectConfigError(() => loadConfig({ file, home: HOME }));
    expect(msg).toContain('ingest.sources');
    expect(msg).toContain('same');
  });

  it('未知 adapter 在加载期报 E_CONFIG（不静默跳过）', () => {
    const file = withYaml('ingest:\n  sources: ["cursor"]\n');
    const msg = expectConfigError(() => loadConfig({ file, home: HOME }));
    expect(msg).toContain('ingest.sources');
    expect(msg).toContain('cursor');
  });
});
