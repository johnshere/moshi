/**
 * CLI 分派。命令按 Phase 逐个注册，`moshi --help` 永远反映真实可用命令。
 */
import os from 'node:os';
import { loadConfig } from '../config.js';
import { importCommand } from './commands/import.js';
import { initCommand } from './commands/init.js';
import { evalCommand } from './commands/eval.js';
import { exportCommand } from './commands/export.js';
import { revokeCommand } from './commands/revoke.js';
import { layoutCommand } from './commands/layout.js';
import { dbCommand } from './commands/db.js';
import { schemaCommand } from './commands/schema.js';
import { samplesCommand } from './commands/samples.js';
import { doctorCommand } from './commands/doctor.js';
import type { Command, CommandContext } from './types.js';

export type { Command, CommandContext };

/** 已注册命令（随 Phase 增加） */
export const COMMANDS: readonly Command[] = [
  importCommand,
  initCommand,
  evalCommand,
  exportCommand,
  revokeCommand,
  layoutCommand,
  dbCommand,
  schemaCommand,
  samplesCommand,
  doctorCommand,
];

export function usage(): string {
  const lines = [
    'moshi —— 本机环境状态记忆系统',
    '',
    '用法：moshi <命令> [参数]',
    '',
    '命令：',
    '  daemon        前台启动守护进程（默认）',
    '  version       打印版本',
  ];
  for (const c of COMMANDS) lines.push(`  ${c.name.padEnd(12)}  ${c.summary}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export interface RunCliOptions {
  /** 覆盖家目录（测试用）；不传即 `os.homedir()`。配置与会话扫描共用这一个值 */
  home?: string;
  /** 显式配置文件（P3-A8）；不传则看 argv 里的 `--config`，再退到默认路径/MOSHI_CONFIG */
  file?: string;
  /** 注入输出（测试用）；不传即 process.stdout */
  stdout?: (s: string) => void;
  /** 注入错误输出（测试用）；不传即 process.stderr */
  stderr?: (s: string) => void;
}

export interface ConfigArgv {
  /** 去掉 `--config` 之后的 argv */
  argv: string[];
  file?: string;
  /** 出现了 `--config` 但后面没有路径 */
  missingValue: boolean;
}

/**
 * 剥离全局 `--config <path>` / `--config=<path>`（P3-A8）。
 *
 * 位置不限：`moshi --config x doctor` 与 `moshi doctor --config x` 都认。
 * 子命令参数里没有 `--config` 这个名字，剥掉不会与任何命令冲突。
 */
export function extractConfigArgv(argv: readonly string[]): ConfigArgv {
  const rest: string[] = [];
  let file: string | undefined;
  let missingValue = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--config') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        missingValue = true;
        continue;
      }
      file = v;
      i += 1;
      continue;
    }
    if (a.startsWith('--config=')) {
      const v = a.slice('--config='.length);
      if (v === '') {
        missingValue = true;
        continue;
      }
      file = v;
      continue;
    }
    rest.push(a);
  }
  return { argv: rest, missingValue, ...(file === undefined ? {} : { file }) };
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s: string) => process.stderr.write(s));

  const global = extractConfigArgv(argv);
  if (global.missingValue) {
    stderr('--config 需要一个配置文件路径\n');
    return 2;
  }

  const name = global.argv[0];
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    process.stdout.write(usage());
    return 0;
  }

  const cmd = COMMANDS.find((c) => c.name === name);
  if (cmd === undefined) {
    process.stderr.write(`未知命令：${name}\n\n${usage()}`);
    return 2;
  }

  const home = options.home ?? os.homedir();
  const file = options.file ?? global.file;
  const cfg = file === undefined ? loadConfig({ home }) : loadConfig({ file, home });
  return cmd.run({
    cfg,
    home,
    args: global.argv.slice(1),
    stdout,
    stderr,
  });
}
