#!/usr/bin/env node
/**
 * sidecar 开发环境供给 CLI（P3-A8）。
 *
 * 语义（用户 2026-11-05 拍板）：
 *   - 默认（无参数）：初次判定——venv 合格就跳过，不合格就重建；失败硬退出（exit 1）
 *   - --force      ：无条件删掉重建（`pnpm setup:sidecar` 用）
 *   - --hook       ：初次判定，但失败只警告不红（`pnpm install` 的 postinstall 用）
 *   - --check      ：只判定输出，不构建
 *
 * 不依赖 tsx / node_modules：postinstall 时机 node_modules 未必就绪，纯 node ESM。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPS_HASH_FILE,
  ENCODE_MODULES_UNIX,
  ENCODE_MODULES_WIN,
  MODEL_REL,
  PYPI_INDEX_DEFAULT,
  WRITE_PROBE,
  classify,
  depsHash,
  parseArgs,
  readRecordedHash,
  sysPythonCommand,
  venvPythonPath,
} from './setup-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_DIR = path.join(ROOT, 'sidecar');
const VENV_DIR = path.join(MODULE_DIR, '.venv');
const REQ_FILE = path.join(MODULE_DIR, 'requirements.txt');
const FETCH_MODEL = path.join(MODULE_DIR, 'fetch_model.py');
const PLATFORM = process.platform;

const say = (m) => console.log(`[setup-sidecar] ${m}`);
const warn = (m) => console.error(`[setup-sidecar][警告] ${m}`);

/** 跑命令；退出码 0 返回 stdout，否则返回 { code, stdout, stderr } */
function run(cmd, args, { inherit = false, timeout = 600_000 } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    stdio: inherit ? 'inherit' : 'pipe',
  });
  if (inherit) return r.status;
  return {
    code: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  };
}

/** 解析 python stderr 里第一个 "No module named 'x'" */
function firstMissingModule(stderr) {
  const m = /No module named '([^']+)'/.exec(stderr ?? '');
  return m ? m[1] : '未知模块';
}

function probeWrite(pythonPath) {
  const r = run(pythonPath, ['-c', WRITE_PROBE], { timeout: 30_000 });
  return r.code === 0 && r.stdout.includes('WRITE_OK');
}

function probeImports(pythonPath, modules) {
  const r = run(pythonPath, ['-c', `import ${modules.join(', ')}; print('IMPORT_OK')`], { timeout: 120_000 });
  if (r.code === 0 && r.stdout.includes('IMPORT_OK')) return { ok: true, missing: [] };
  // python 多模块 import 遇首个失败即中断，stderr 只报第一个缺失模块
  const named = firstMissingModule(r.stderr);
  return { ok: false, missing: named === '未知模块' ? modules : [named] };
}

/** 定位系统 Python：py 启动器（Windows）或 python3（unix）→ 真实 sys.executable */
function resolveSysPython(platform) {
  const [cmd, args] = sysPythonCommand(platform);
  const r = run(cmd, args, { timeout: 30_000 });
  const exe = r.code === 0 ? r.stdout.trim() : '';
  return exe === '' ? null : exe;
}

/** 当前 venv 质量判定（真实探测版） */
function inspectVenv(platform) {
  const venvPy = venvPythonPath(VENV_DIR, platform);
  const venvExists = existsSync(venvPy);
  const writeOk = venvExists ? probeWrite(venvPy) : false;
  const mods = platform === 'win32' ? ENCODE_MODULES_WIN : ENCODE_MODULES_UNIX;
  const imp = venvExists ? probeImports(venvPy, mods) : { ok: false, missing: mods };
  const modelOk = existsSync(path.join(MODULE_DIR, MODEL_REL));
  const dep = depsHash(MODULE_DIR);
  const depsHashOk = venvExists && readRecordedHash(VENV_DIR) === dep.hash;
  return {
    venvExists,
    writeOk,
    importOk: imp.ok,
    importMissing: imp.missing,
    depsHashOk,
    modelOk,
    depsSource: dep.source,
    venvPy,
  };
}

function runBuild(sysPy, fetchModel) {
  say(`删除旧 venv：${VENV_DIR}`);
  rmSync(VENV_DIR, { recursive: true, force: true });
  say(`创建 venv：${sysPy} -m venv`);
  const v = run(sysPy, ['-m', 'venv', VENV_DIR], { inherit: true });
  if (v !== 0) return false;
  const venvPy = venvPythonPath(VENV_DIR, PLATFORM);
  const index = process.env.PIP_INDEX_URL ?? PYPI_INDEX_DEFAULT;
  say(`安装依赖：${venvPy} -m pip install -i ${index} -r requirements.txt`);
  const p = run(venvPy, ['-m', 'pip', 'install', '-i', index, '-r', REQ_FILE], { inherit: true, timeout: 0 });
  if (p !== 0) return false;
  if (fetchModel) {
    say('拉取模型权重：fetch_model.py（hf-mirror）');
    const f = run(venvPy, [FETCH_MODEL], { inherit: true, timeout: 0 });
    if (f !== 0) return false;
  }
  const dep = depsHash(MODULE_DIR);
  writeFileSync(path.join(VENV_DIR, DEPS_HASH_FILE), dep.hash, 'utf8');
  say(`已记录依赖 hash（${dep.source}）：${dep.hash}`);
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown !== undefined) {
    warn(`未知参数：--${args.unknown}`);
    return 2;
  }
  if (args.help) {
    console.log([
      '用法：node scripts/setup-sidecar.mjs [--force | --hook | --check]',
      '',
      'sidecar 开发环境供给（P3-A8）：建/检 sidecar/.venv、装依赖、拉模型权重。',
      '',
      '  （默认） 初次判定：venv 合格跳过，不合格重建；失败退出码 1',
      '  --force  无条件删掉重建（pnpm setup:sidecar）',
      '  --hook   初次判定；失败只警告、退出码 0（pnpm install postinstall）',
      '  --check  只判定输出，不构建；不合格退出码 3',
      '  --help   显示本帮助',
      '',
    ].join('\n'));
    return 0;
  }

  const sysPy = resolveSysPython(PLATFORM);
  if (sysPy === null) {
    warn('找不到系统 Python（py / python3）。请先安装 Python 3.13 x64。');
    return args.hook ? 0 : 1;
  }
  say(`系统 Python：${sysPy}`);

  if (args.force) {
    say('--force：无条件重建 venv');
    const built = runBuild(sysPy, true);
    if (!built) {
      warn('重建失败，请检查上面的错误输出。');
      return args.hook ? 0 : 1;
    }
  } else {
    const st = inspectVenv(PLATFORM);
    if (st.venvExists) {
      say(`判定：${st.venvPy}`);
      say(`  写主目录探测 ${st.writeOk ? '通过' : '失败'} · 模块 ${st.importOk ? '齐全' : `缺 ${st.importMissing.join(', ')}`} · 模型 ${st.modelOk ? '在' : '缺'} · 依赖hash ${st.depsHashOk ? '一致' : '不一致'}`);
    }
    const verdict = classify({
      venvExists: st.venvExists,
      writeOk: st.writeOk,
      importOk: st.importOk,
      importMissing: st.importMissing,
      depsHashOk: st.depsHashOk,
      modelOk: st.modelOk,
    });

    if (args.check) {
      console.log(`[setup-sidecar][check] ${verdict.ok ? '合格' : `不合格：${verdict.reason}（${verdict.detail}）`}`);
      return verdict.ok ? 0 : 3;
    }

    if (verdict.ok) {
      say('venv 已就绪，跳过构建');
      return 0;
    }

    say(`判定不合格：${verdict.reason}（${verdict.detail}）→ ${verdict.action === 'fetch-model' ? '补拉模型权重' : '重建 venv'}`);
    const built = runBuild(sysPy, true);
    if (!built) {
      warn('构建失败，请检查上面的错误输出。');
      return args.hook ? 0 : 1;
    }
  }

  // 最终验收：用与判定相同的判据再验一次
  const final = inspectVenv(PLATFORM);
  const verdict = classify({
    venvExists: final.venvExists,
    writeOk: final.writeOk,
    importOk: final.importOk,
    importMissing: final.importMissing,
    depsHashOk: final.depsHashOk,
    modelOk: final.modelOk,
  });
  if (verdict.ok) {
    say(`构建完成并验收通过：${final.venvPy}`);
    return 0;
  }
  warn(`构建后验收仍不合格：${verdict.reason}（${verdict.detail}）`);
  return args.hook ? 0 : 1;
}

process.exitCode = main();
