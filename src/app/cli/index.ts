/**
 * CLI 分派。命令按 Phase 逐个注册，`moshi --help` 永远反映真实可用命令。
 */
import { loadConfig, type Config } from '../config.js';

export interface CommandContext {
  cfg: Config;
  args: readonly string[];
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface Command {
  name: string;
  summary: string;
  run: (ctx: CommandContext) => Promise<number>;
}

/** 已注册命令（随 Phase 增加） */
export const COMMANDS: readonly Command[] = [];

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

export async function runCli(argv: readonly string[]): Promise<number> {
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

  const cfg = loadConfig();
  return cmd.run({
    cfg,
    args: argv.slice(1),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
}
