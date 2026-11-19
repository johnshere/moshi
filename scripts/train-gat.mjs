#!/usr/bin/env node
/**
 * GAT 训练流水线（P1②）：build → export → train → 部署权重。
 *
 * 用法：
 *   node scripts/train-gat.mjs [--config <file>] [--out <model.pt>] [--epochs N]
 *
 * - 前两步直接复用 CLI（`moshi samples build|export`），不在这里重写样本/导出逻辑；
 * - 导出文件由 export 自己打印的 JSON 决定（默认 `<data_dir>/train/samples.jsonl`）；
 * - 训练用 `sidecar/.venv` 里的 CPU torch，不下载权重；
 * - 训练完自动把权重复制到 `<data_dir>/models/gat-v1.pt`（sidecar 的固定读取路径），
 *   同时保留仓库内 `models/gat-v1.pt` 作为可复现的产物（该目录已 gitignore）。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`[train:gat] ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: repoRoot, stdio: 'inherit', ...opts });
  if (res.error !== undefined) fail(`无法执行 ${cmd}：${res.error.message}`);
  if (res.status !== 0) process.exit(res.status ?? 1);
  return res;
}

function runCapture(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' });
  if (res.error !== undefined) fail(`无法执行 ${cmd}：${res.error.message}`);
  if (res.status !== 0) {
    process.stderr.write(res.stderr ?? '');
    process.exit(res.status ?? 1);
  }
  return res.stdout ?? '';
}

// ── 参数 ──
const argv = process.argv.slice(2);
let configFile;
let outFile = path.join(repoRoot, 'models', 'gat-v1.pt');
let epochs = '30';
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--config') configFile = argv[++i];
  else if (arg === '--out') outFile = path.resolve(argv[++i] ?? '');
  else if (arg === '--epochs') epochs = argv[++i];
  else fail(`未知参数：${arg}（支持 --config / --out / --epochs）`);
}
if (outFile === '') fail('--out 需要一个路径');

const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!existsSync(tsxCli)) fail('没装 tsx：先在工程根执行 pnpm install');
const main = path.join(repoRoot, 'src', 'app', 'main.ts');
const cfgArgs = configFile === undefined ? [] : ['--config', configFile];

// ── 1) 构造样本（幂等）──
run(process.execPath, [tsxCli, main, ...cfgArgs, 'samples', 'build']);

// ── 2) 导出 JSONL（导出结果 JSON 里带 out 路径）──
const stdout = runCapture(process.execPath, [tsxCli, main, ...cfgArgs, 'samples', 'export']);
process.stdout.write(stdout);
const exported = JSON.parse(stdout);
const dataFile = exported.out;
if (typeof dataFile !== 'string' || !existsSync(dataFile)) fail(`导出的 JSONL 不存在：${dataFile}`);
if (exported.exported === 0) fail('没有可导出的样本：先积累 adjudication/feedback');

// ── 3) 训练（CPU）──
const py = process.platform === 'win32'
  ? path.join(repoRoot, 'sidecar', '.venv', 'Scripts', 'python.exe')
  : path.join(repoRoot, 'sidecar', '.venv', 'bin', 'python');
if (!existsSync(py)) fail(`没找到 sidecar 虚拟环境解释器：${py}（不要重装/升级环境，见 README）`);

const startedAt = Date.now();
run(py, ['train.py', '--data', dataFile, '--out', outFile, '--epochs', epochs, '--verbose'], {
  cwd: path.join(repoRoot, 'sidecar'),
});
const seconds = Math.round((Date.now() - startedAt) / 1000);

// ── 4) 部署到 sidecar 的固定读取路径 ──
// 导出文件在 `<data_dir>/train/`，故 data_dir = 上两级目录。
const dataDir = path.dirname(path.dirname(dataFile));
const servePath = path.join(dataDir, 'models', 'gat-v1.pt');
mkdirSync(path.dirname(servePath), { recursive: true });
if (path.resolve(servePath) !== path.resolve(outFile)) copyFileSync(outFile, servePath);

console.log(
  JSON.stringify(
    { samples: dataFile, exported: exported.exported, model: outFile, serve_path: servePath, train_seconds: seconds },
    null,
    2,
  ),
);
console.log('[train:gat] 完成。schema 未变，gat_mode 仍为 off；验证见 pnpm check:gat -- --config <配置文件>');
