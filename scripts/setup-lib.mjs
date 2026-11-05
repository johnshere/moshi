/**
 * sidecar 开发环境供给——纯逻辑（可被 vitest 直接 import，无副作用）。
 *
 * 用途（P3-A8）：把「建 venv → 装依赖 → 拉权重 → 自检」固化成可复现命令，
 * 使工程运行不依赖本机环境：
 *   - 判定合格 = venv 存在 + 解释器能写用户主目录（完整性级别检查，B-7）
 *     + 必需模块可 import + 模型权重在 + 依赖声明 hash 一致；
 *   - 判据与运行时探测（src/infra/sidecar/python.ts）同一口径，不写两套。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** pip 镜像：环境变量可覆盖（PIP_INDEX_URL），默认清华（P3-A2 实测选定） */
export const PYPI_INDEX_DEFAULT = 'https://pypi.tuna.tsinghua.edu.cn/simple';

/** 编码栈必需模块：与 SIDECAR_ENCODE_MODULES 对齐（src/infra/sidecar/python.ts） */
export const ENCODE_MODULES_WIN = ['win32pipe', 'win32file', 'torch', 'sentence_transformers'];
export const ENCODE_MODULES_UNIX = ['torch', 'sentence_transformers'];

/** 模型权重判据（P3-A3：BAAI 原版 safetensors；旧 onnx 变体不算） */
export const MODEL_REL = path.join('models', 'bge-small-zh-v1.5', 'model.safetensors');

/** venv 内记录的依赖声明 hash 文件名 */
export const DEPS_HASH_FILE = '.moshi-deps-hash';

/** 锁定文件优先；不存在时退回 requirements.txt（锁文件生成工具选型待定） */
export const LOCK_FILE = 'requirements.lock';
export const REQ_FILE = 'requirements.txt';

export function parseArgs(argv) {
  const out = { force: false, hook: false, check: false, help: false };
  for (const a of argv) {
    if (a === '--force') out.force = true;
    else if (a === '--hook') out.hook = true;
    else if (a === '--check') out.check = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else return { unknown: a.replace(/^--?/, '') };
  }
  return out;
}

/** venv 解释器路径（Windows Scripts/python.exe，unix bin/python） */
export function venvPythonPath(venvDir, platform) {
  return platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

/** 系统 Python 探测命令（返回 [cmd, args]）：Windows 用 py 启动器（尊重用户默认版本） */
export function sysPythonCommand(platform) {
  return platform === 'win32'
    ? ['py', ['-c', 'import sys; print(sys.executable)']]
    : ['python3', ['-c', 'import sys; print(sys.executable)']];
}

/** 写探测内联脚本：在用户主目录写临时文件再删。低完整性进程会失败（B-7 的 No-Write-Up） */
export const WRITE_PROBE = [
  'import os, sys',
  'from pathlib import Path',
  'p = Path.home() / ("moshi-setup-probe-" + str(os.getpid()))',
  'try:',
  '    with open(p, "w", encoding="utf-8") as f:',
  '        f.write("ok")',
  '    p.unlink()',
  '    print("WRITE_OK")',
  'except OSError as e:',
  '    print("WRITE_FAIL", e.errno, getattr(e, "winerror", ""), repr(e.strerror))',
  '    sys.exit(3)',
].join('\n');

/** 依赖声明（锁文件优先）的 sha256 前 16 位 */
export function depsHash(moduleDir) {
  const lock = path.join(moduleDir, LOCK_FILE);
  const src = existsSync(lock) ? lock : path.join(moduleDir, REQ_FILE);
  const content = readFileSync(src, 'utf8');
  return {
    source: path.basename(src),
    hash: createHash('sha256').update(content).digest('hex').slice(0, 16),
  };
}

/** 读取 venv 内上次记录的依赖 hash；无记录返回 null */
export function readRecordedHash(venvDir) {
  try {
    return readFileSync(path.join(venvDir, DEPS_HASH_FILE), 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * venv 质量判定（纯函数，探测结果由调用方注入）。
 *
 * 返回 { ok, reason, action, detail }：
 *   action: 'none' | 'rebuild' | 'fetch-model'
 */
export function classify({ venvExists, writeOk, importOk, importMissing, depsHashOk, modelOk }) {
  if (!venvExists) {
    return { ok: false, reason: 'E_NO_VENV', action: 'rebuild', detail: 'venv 不存在' };
  }
  if (!writeOk) {
    return {
      ok: false,
      reason: 'E_NO_WRITE',
      action: 'rebuild',
      detail: '解释器无法写用户主目录（完整性级别过低或权限问题，见 B-7）',
    };
  }
  if (!importOk) {
    return {
      ok: false,
      reason: 'E_MODULE_MISSING',
      action: 'rebuild',
      detail: `缺模块：${importMissing.join(', ')}`,
    };
  }
  if (!depsHashOk) {
    return {
      ok: false,
      reason: 'E_DEPS_HASH',
      action: 'rebuild',
      detail: '依赖声明（requirements.txt / requirements.lock）已变化',
    };
  }
  if (!modelOk) {
    return {
      ok: false,
      reason: 'E_MODEL_MISSING',
      action: 'fetch-model',
      detail: `缺模型权重：${MODEL_REL}`,
    };
  }
  return { ok: true, reason: null, action: 'none', detail: '就绪' };
}
