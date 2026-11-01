/**
 * 进程与端口类解析器（详设 §5.3.1 #12–#15）。
 *
 * 这一组的置信度整体比 `pkg.*` 低一档（0.85–0.95），原因是**列数依赖工具版本**：
 * `lsof` 在 macOS / Linux 上列数一致，但 `ps` 的 `aux` / `-ef` 两种格式列序完全不同。
 * 所以 `proc.ps` 不写死列号，而是**先读表头找 `CMD` 列**——写死列号在换平台后
 * 会把整行错位解析成垃圾事实，而垃圾事实比没有事实更糟（概设 §3.2）。
 */
import { buildContent } from '../content.js';
import type { ExtractedFact, Parser } from '../types.js';
import { allMatches, argvOf, excerpt, group, lines } from '../util.js';

/** `node 48213 john 23u IPv4 0x1234 0t0 TCP *:8080 (LISTEN)` */
const LSOF_LISTEN = /^(\S+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+TCP (\S+):(\d+) \(LISTEN\)/gm;
/** `tcp 0 0 0.0.0.0:8080 0.0.0.0:* LISTEN 48213/node` */
const NETSTAT_LISTEN = /:(\d+)\s+[^\n]*LISTEN(?:ING)?\s+(\d+)\/(\S+)/gm;
const EADDRINUSE = /EADDRINUSE[^\n]*?:(\d+)/;

const LSOF_COMMAND = /(?:^|[\s;&|])lsof\b/;
const NETSTAT_COMMAND = /(?:^|[\s;&|])netstat\b/;
const PS_COMMAND = /(?:^|[\s;&|])ps\b/;

const lsofParser: Parser = {
  id: 'proc.lsof',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => LSOF_COMMAND.test(turn.cmd) && allMatches(turn.output, LSOF_LISTEN).length > 0,
  extract: (turn) => {
    const facts: ExtractedFact[] = [];
    for (const m of allMatches(turn.output, LSOF_LISTEN)) {
      const port = group(m, 4);
      const value = { process: group(m, 1), pid: Number(group(m, 2)), port: Number(port) };
      const subject = { name: port, type: 'port' as const };
      facts.push({
        content: buildContent(subject, 'occupied_by', value),
        subject,
        predicate: 'occupied_by',
        value,
        confidence: 0.95,
        ftype: 'semantic',
        ext: { tool: 'lsof', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      });
    }
    return facts;
  },
};

const netstatParser: Parser = {
  id: 'proc.netstat',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) =>
    NETSTAT_COMMAND.test(turn.cmd) && allMatches(turn.output, NETSTAT_LISTEN).length > 0,
  extract: (turn) => {
    const facts: ExtractedFact[] = [];
    for (const m of allMatches(turn.output, NETSTAT_LISTEN)) {
      const port = group(m, 1);
      const value = { process: group(m, 3), pid: Number(group(m, 2)), port: Number(port) };
      const subject = { name: port, type: 'port' as const };
      facts.push({
        content: buildContent(subject, 'occupied_by', value),
        subject,
        predicate: 'occupied_by',
        value,
        confidence: 0.9,
        ftype: 'semantic',
        ext: { tool: 'netstat', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      });
    }
    return facts;
  },
};

/**
 * `ps aux` 表头：`USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND`
 * `ps -ef` 表头：`UID PID PPID C STIME TTY TIME CMD`
 * 两者 `CMD` 列的位置差 3，所以按表头找，不写死。
 */
function findCommandColumn(header: string): { pid: number; cmd: number } | null {
  const cols = header.trim().split(/\s+/).map((c) => c.toUpperCase());
  const pid = cols.indexOf('PID');
  const cmd = cols.indexOf('COMMAND') >= 0 ? cols.indexOf('COMMAND') : cols.indexOf('CMD');
  if (pid < 0 || cmd < 0 || cmd <= pid) return null;
  return { pid, cmd };
}

const psParser: Parser = {
  id: 'proc.ps',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => PS_COMMAND.test(turn.cmd) && findPsLayout(turn.output) !== null,
  extract: (turn) => {
    const layout = findPsLayout(turn.output);
    if (layout === null) return [];
    const facts: ExtractedFact[] = [];
    for (const line of lines(turn.output)) {
      if (line.trim() === '') continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length <= layout.cmd) continue;
      const pidRaw = cols[layout.pid] ?? '';
      if (!/^\d+$/.test(pidRaw)) continue; // 表头行、空行、截断行都从这里被挡掉
      const command = cols.slice(layout.cmd).join(' ');
      const process = (command.split(/\s+/)[0] ?? '').replace(/^.*[/\\]/, '');
      if (process === '') continue;
      const value = { process, pid: Number(pidRaw), command: excerpt(command, 120) };
      const subject = { name: process, type: 'process' as const };
      facts.push({
        content: buildContent(subject, 'running', value),
        subject,
        predicate: 'running',
        value,
        confidence: 0.85,
        ftype: 'episodic',
        ext: { tool: 'ps', argv: argvOf(turn.cmd), raw_excerpt: excerpt(line) },
      });
    }
    return facts;
  },
};

function findPsLayout(output: string): { pid: number; cmd: number } | null {
  for (const line of lines(output)) {
    if (!/\bPID\b/.test(line)) continue;
    const layout = findCommandColumn(line);
    if (layout !== null) return layout;
  }
  return null;
}

const eaddrinuseParser: Parser = {
  id: 'err.eaddrinuse',
  tools: ['bash', 'shell', 'exec'],
  match: (turn) => EADDRINUSE.test(turn.output),
  extract: (turn) => {
    const m = EADDRINUSE.exec(turn.output);
    if (m === null) return [];
    const port = group(m, 1);
    const subject = { name: port, type: 'port' as const };
    return [
      {
        content: buildContent(subject, 'port_conflict', { port: Number(port) }),
        subject,
        predicate: 'port_conflict',
        value: { port: Number(port) },
        confidence: 0.95,
        ftype: 'episodic',
        ext: { tool: 'runtime', argv: argvOf(turn.cmd), raw_excerpt: excerpt(m[0]) },
      },
    ];
  },
};

export const PROC_PARSERS: readonly Parser[] = [
  lsofParser,
  netstatParser,
  psParser,
  eaddrinuseParser,
];

export { findCommandColumn, findPsLayout };
