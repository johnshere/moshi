#!/usr/bin/env node
/**
 * Windows 安装包构建（V-03）。
 *
 * 产物只含**默识自己的程序**（dist + 生产 node_modules + 迁移 + sidecar 源码 +
 * 启动脚本），不含 Node.js / Python / 模型权重：这些是运行环境，由安装向导在
 * 安装阶段按需下载（Node）或安装后由用户按需安装（Python 组件，V-04）。
 *
 * 步骤：pnpm build → pnpm deploy（生产依赖）→ 裁剪非运行时文件 → 复制启动脚本
 * → 查 Node 22 最新版本（失败用兜底）→ makensis 打包。
 *
 * 用法：node scripts/build-installer.mjs [--skip-build]
 *   环境变量 MAKENSIS 可覆盖 makensis 路径。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'temp', 'installer');
/**
 * 每次构建用全新目录：Windows 上 pnpm deploy 的拷贝偶尔被杀软/索引器占住，
 * 复用旧目录会在清理阶段 EBUSY。旧目录留到最后尽力清理。
 */
const STAGE = path.join(OUT_DIR, `stage-${process.pid}-${Date.now()}`);
const PACKAGING = path.join(ROOT, 'packaging', 'windows');
const FALLBACK_NODE = '22.19.0';
const MIN_NODE = '22.18.0';
/** Windows 上 pnpm 是 .cmd，spawnSync 必须经 shell 才能解析 */
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const PNPM_OPTS = process.platform === 'win32' ? { shell: true } : {};

const say = (m) => console.log(`[installer] ${m}`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`命令失败（${String(r.status)}）：${cmd} ${args.join(' ')}`);
  return r;
}

function readVersion() {
  const src = readFileSync(path.join(ROOT, 'src', 'app', 'version.ts'), 'utf8');
  const m = /VERSION\s*=\s*'([^']+)'/.exec(src);
  if (m === null) throw new Error('src/app/version.ts 里没有 VERSION');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.version !== m[1]) {
    throw new Error(`package.json ${pkg.version} 与 version.ts ${m[1]} 不一致`);
  }
  return m[1];
}

function findMakensis() {
  const candidates = [
    process.env.MAKENSIS,
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ].filter((p) => typeof p === 'string' && p !== '');
  for (const c of candidates) if (existsSync(c)) return c;
  const probe = spawnSync('makensis', ['/VERSION'], { encoding: 'utf8', shell: false });
  if (probe.error === undefined) return 'makensis';
  throw new Error('找不到 makensis：安装 NSIS 或设置 MAKENSIS 环境变量');
}

async function fetchNodeVersion() {
  try {
    const res = await fetch('https://nodejs.org/dist/index.json', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    const rows = await res.json();
    const v22 = rows.find((r) => typeof r.version === 'string' && r.version.startsWith('v22.'));
    if (v22 === undefined) throw new Error('index.json 没有 v22');
    return v22.version.slice(1);
  } catch (err) {
    console.warn(`[installer] 查 Node 版本失败（${err.message}），使用兜底 ${FALLBACK_NODE}`);
    return FALLBACK_NODE;
  }
}

/** Windows 上目录偶尔被杀软/索引占用，删除重试几次 */
function rmrf(p) {
  rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}

/**
 * 从 deploy 目录只拷运行时文件到干净 stage。
 *
 * 不在 deploy 目录里删文件：pnpm deploy 会把整个仓库（含 src/ui/node_modules）
 * 拷过去，Windows 上删除这些拷贝目录会偶发 EBUSY（句柄在杀软/索引器手里）。
 * 换成"只拷需要的"，删不掉的是临时 deploy 目录，不影响产物。
 */
function buildStage(deployDir) {
  mkdirSync(STAGE, { recursive: true });
  const copy = ['dist', 'node_modules', 'migrations', 'sidecar'];
  for (const entry of copy) {
    cpSync(path.join(deployDir, entry), path.join(STAGE, entry), { recursive: true });
  }
  const pkg = JSON.parse(readFileSync(path.join(deployDir, 'package.json'), 'utf8'));
  writeFileSync(
    path.join(STAGE, 'package.json'),
    `${JSON.stringify(
      { name: pkg.name, version: pkg.version, private: true, type: pkg.type, bin: pkg.bin },
      null,
      2,
    )}\n`,
  );
  for (const rel of [
    'node_modules/.pnpm',
    'node_modules/.bin',
    'node_modules/.modules.yaml',
    'sidecar/models',
    'sidecar/tests',
    'sidecar/__pycache__',
    'sidecar/.venv',
    'sidecar/train.py',
    'sidecar/conftest.py',
    'sidecar/pytest.ini',
    'sidecar/requirements-dev.txt',
    'sidecar/moshi_sidecar/__pycache__',
  ]) {
    rmrf(path.join(STAGE, rel));
  }
}

function copyLaunchers() {
  for (const f of ['moshi.cmd', 'launch.vbs']) {
    cpSync(path.join(PACKAGING, f), path.join(STAGE, f));
  }
  const tools = path.join(STAGE, 'tools');
  mkdirSync(tools, { recursive: true });
  for (const f of ['check-node.ps1', 'install-node.ps1', 'install-python.ps1', 'stop-moshi.ps1']) {
    cpSync(path.join(PACKAGING, f), path.join(tools, f));
  }
}

async function main() {
  const skipBuild = process.argv.includes('--skip-build');
  const version = readVersion();

  if (!skipBuild) {
    say('构建应用（pnpm build）');
    run(PNPM, ['build'], PNPM_OPTS);
  }
  if (!existsSync(path.join(ROOT, 'dist', 'app', 'main.js'))) {
    throw new Error('dist/app/main.js 不存在：先运行 pnpm build');
  }

  say('准备生产依赖（pnpm deploy）');
  try {
    for (const entry of readdirSync(OUT_DIR)) {
      if (entry.startsWith('stage-') || entry.startsWith('deploy-')) {
        rmrf(path.join(OUT_DIR, entry));
      }
    }
  } catch {
    /* 旧目录被占用就留着，不影响本次构建 */
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const deployDir = path.join(OUT_DIR, `deploy-${process.pid}-${Date.now()}`);
  run(PNPM, ['--filter', 'moshi', 'deploy', deployDir, '--prod', '--legacy', '--node-linker=hoisted'], PNPM_OPTS);
  if (!existsSync(path.join(deployDir, 'node_modules', 'better-sqlite3'))) {
    throw new Error('deploy 后缺少 better-sqlite3');
  }

  say('组装运行时文件');
  buildStage(deployDir);
  copyLaunchers();

  const nodeVersion = await fetchNodeVersion();
  const makensis = findMakensis();
  const outFile = path.join(OUT_DIR, `moshi-setup-${version}.exe`);
  say(`打包（Node ${nodeVersion}，产物 ${path.relative(ROOT, outFile)}）`);
  run(makensis, [
    `/DAPP_VERSION=${version}`,
    `/DAPP_VERSION4=${version}.0`,
    `/DNODE_VERSION=${nodeVersion}`,
    `/DMIN_NODE=${MIN_NODE}`,
    `/DSTAGE_DIR=${STAGE}`,
    `/DPACKAGING_DIR=${PACKAGING}`,
    `/DOUT_FILE=${outFile}`,
    `/INPUTCHARSET`,
    'UTF8',
    path.join(PACKAGING, 'installer.nsi'),
  ]);

  const mb = (statSync(outFile).size / 1024 / 1024).toFixed(1);
  say(`完成：${outFile}（${mb} MB）`);
}

await main();
