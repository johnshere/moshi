import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataPaths, expandHome, loadConfig } from '../../src/app/config.js';
import { EMBED_DIM, EMBED_MODEL } from '../../src/domain/embedding.js';
import { isMoshiError } from '../../src/domain/errors.js';

const HOME = path.join(tmpdir(), 'moshi-home-test');

function withToml(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-cfg-'));
  const file = path.join(dir, 'config.toml');
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
    const cfg = loadConfig({ file: path.join(tmpdir(), 'nope', 'config.toml'), home: HOME });
    expect(cfg.server.port).toBe(53000);
    expect(cfg.model.gat_mode).toBe('off');
    expect(cfg.retrieval.rrf_k).toBe(60);
    expect(cfg.ingest.sources).toEqual(['claude-code']);
  });

  it('拼错的键启动失败，且错误信息指出键名', () => {
    const file = withToml('[server]\nprot = 53001\n');
    const msg = expectConfigError(() => loadConfig({ file, home: HOME }));
    expect(msg).toContain('server.prot');
    expect(msg).toContain('未知配置键');
  });

  it('未知 section 同样拒绝', () => {
    const file = withToml('[retreival]\nvector_topk = 5\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('retreival');
  });

  it('只写要改的键，其余用默认值', () => {
    const file = withToml('[retrieval]\nvector_topk = 5\n');
    const cfg = loadConfig({ file, home: HOME });
    expect(cfg.retrieval.vector_topk).toBe(5);
    expect(cfg.retrieval.bm25_topk).toBe(20);
    expect(cfg.packing.token_budget).toBe(1500);
  });

  it('~ 展开为绝对路径，且不碰非路径键', () => {
    const file = withToml('[storage]\ndata_dir = "~/data-moshi"\n');
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
    const file = withToml('[server]\nhost = "0.0.0.0"\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('回环');
  });

  it('port 大于 port_scan_max 拒绝', () => {
    const file = withToml('[server]\nport = 53030\nport_scan_max = 53020\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('port_scan_max');
  });

  it('概率越界被 zod 拦下', () => {
    const file = withToml('[packing]\nutility_ratio = 1.5\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('packing.utility_ratio');
  });

  it('gat_mode 只接受三档', () => {
    const file = withToml('[model]\ngat_mode = "maybe"\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('model.gat_mode');
  });

  it('非法 TOML 报 E_CONFIG 而不是抛原生异常', () => {
    const file = withToml('[server\nport = 1\n');
    expect(expectConfigError(() => loadConfig({ file, home: HOME }))).toContain('TOML');
  });

  it('示例配置能被完整解析（防止 config.example.toml 与 schema 漂移）', () => {
    const example = path.resolve(import.meta.dirname, '../../config.example.toml');
    const cfg = loadConfig({ file: example, home: HOME });
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.storage.backup_keep).toBe(7);
    expect(cfg.sidecar.score_timeout_ms).toBe(120);
    expect(cfg.archive.include_raw).toBe(false);
    expect(cfg.ui.theme).toBe('system');
    expect(cfg.log.keep_days).toBe(7);
    // P2-23：直写闸门默认必须关着——示例配置哪天写错了，这条会先炸
    expect(cfg.mcp.allow_direct_write).toBe(false);
    expect(cfg.mcp.direct_write_batch_max).toBe(50);
    expect(cfg.mcp.direct_write_per_minute_max).toBe(120);
  });

  it('dataPaths 落在 data_dir 之下', () => {
    const cfg = loadConfig({ file: path.join(tmpdir(), 'x', 'y.toml'), home: HOME });
    const p = dataPaths(cfg);
    expect(p.db.startsWith(cfg.storage.data_dir)).toBe(true);
    expect(p.db.endsWith('moshi.db')).toBe(true);
    expect(p.lock.endsWith('daemon.lock')).toBe(true);
  });
});
