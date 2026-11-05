/**
 * setup-lib 单测（P3-A8）：参数解析 + venv 质量判定 + 依赖 hash。
 *
 * 判定为纯函数，探测结果注入，不碰真实进程/文件系统（除 depsHash 读 requirements.txt）。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { classify, depsHash, parseArgs, readRecordedHash, venvPythonPath } from '../../scripts/setup-lib.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('parseArgs', () => {
  it('默认全部 false（初次判定模式）', () => {
    expect(parseArgs([])).toEqual({ force: false, hook: false, check: false, help: false });
  });
  it('识别 --force / --hook / --check / --help', () => {
    expect(parseArgs(['--force']).force).toBe(true);
    expect(parseArgs(['--hook']).hook).toBe(true);
    expect(parseArgs(['--check']).check).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
  it('未知参数返回 { unknown }', () => {
    expect(parseArgs(['--nope'])).toEqual({ unknown: 'nope' });
  });
});

describe('classify（venv 质量判定）', () => {
  const base = { venvExists: true, writeOk: true, importOk: true, importMissing: [], depsHashOk: true, modelOk: true };
  it('全部通过 → ok / none', () => {
    expect(classify(base)).toEqual({ ok: true, reason: null, action: 'none', detail: '就绪' });
  });
  it('venv 不存在 → rebuild', () => {
    const r = classify({ ...base, venvExists: false });
    expect(r).toMatchObject({ ok: false, reason: 'E_NO_VENV', action: 'rebuild' });
  });
  it('写主目录失败（低完整性/权限，B-7）→ rebuild + E_NO_WRITE', () => {
    const r = classify({ ...base, writeOk: false });
    expect(r).toMatchObject({ ok: false, reason: 'E_NO_WRITE', action: 'rebuild' });
  });
  it('缺模块 → rebuild + E_MODULE_MISSING（带缺的模块名）', () => {
    const r = classify({ ...base, importOk: false, importMissing: ['torch'] });
    expect(r).toMatchObject({ ok: false, reason: 'E_MODULE_MISSING', action: 'rebuild' });
    expect(r.detail).toContain('torch');
  });
  it('依赖声明 hash 变化 → rebuild', () => {
    const r = classify({ ...base, depsHashOk: false });
    expect(r).toMatchObject({ ok: false, reason: 'E_DEPS_HASH', action: 'rebuild' });
  });
  it('缺模型权重 → 只补拉权重（fetch-model，不重建）', () => {
    const r = classify({ ...base, modelOk: false });
    expect(r).toMatchObject({ ok: false, reason: 'E_MODEL_MISSING', action: 'fetch-model' });
  });
  it('hash 变化优先于模型缺失（依赖变了先重建）', () => {
    const r = classify({ ...base, depsHashOk: false, modelOk: false });
    expect(r.reason).toBe('E_DEPS_HASH');
  });
});

describe('venvPythonPath', () => {
  it('Windows 用 Scripts/python.exe，unix 用 bin/python', () => {
    expect(venvPythonPath('D:/v', 'win32')).toMatch(/Scripts[\\/]python\.exe$/);
    expect(venvPythonPath('/v', 'linux')).toMatch(/bin[\\/]python$/);
  });
});

describe('depsHash / readRecordedHash（真实临时目录）', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  it('hash 确定性且随内容变化；锁定文件存在时优先', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'moshi-deps-'));
    const req = path.join(dir, 'requirements.txt');
    writeFileSync(req, 'torch>=2.5\n', 'utf8');
    const h1 = depsHash(dir);
    expect(h1.hash).toMatch(/^[0-9a-f]{16}$/);
    writeFileSync(req, 'torch>=2.6\n', 'utf8');
    expect(depsHash(dir).hash).not.toBe(h1.hash);
    // 锁定文件优先
    const lock = path.join(dir, 'requirements.lock');
    writeFileSync(lock, 'torch==2.7.0\n', 'utf8');
    expect(depsHash(dir).source).toBe('requirements.lock');
  });
  it('readRecordedHash：无记录返回 null，有记录返回内容', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'moshi-deps-'));
    expect(readRecordedHash(dir)).toBe(null);
    writeFileSync(path.join(dir, '.moshi-deps-hash'), 'abc123', 'utf8');
    expect(readRecordedHash(dir)).toBe('abc123');
  });
});
