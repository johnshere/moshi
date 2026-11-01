/**
 * CLI 分派。命令按 Phase 逐个注册，`moshi --help` 永远反映真实可用命令。
 */
import os from 'node:os';
import { loadConfig } from '../config.js';
import { importCommand } from './commands/import.js';
import { initCommand } from './commands/init.js';
import { evalCommand } from './commands/eval.js';
import { exportCommand } from './commands/export.js';
import type { Command, CommandContext } from './types.js';

export type { Command, CommandContext };

/** 已注册命令（随 Phase 增加） */
export const COMMANDS: readonly Command[] = [importCommand, initCommand, evalCommand, exportCommand];

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
  /** 注入输出（测试用）；不传即 process.stdout */
  stdout?: (s: string) => void;
  /** 注入错误输出（测试用）；不传即 process.stderr */
  stderr?: (s: string) => void;
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const name = argv[0];
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
  const cfg = loadConfig({ home });
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s: string) => process.stderr.write(s));
  return cmd.run({
    cfg,
    home,
    args: argv.slice(1),
    stdout,
    stderr,
  });
}
