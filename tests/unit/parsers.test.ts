import { describe, expect, it } from 'vitest';
import { buildContent, describeValue, predicateLabel } from '../../src/core/parse/content.js';
import { BUILTIN_PARSERS, ParserRegistry, parseTurn } from '../../src/core/parse/registry.js';
import type { ExtractedFact, Parser, RawTurn } from '../../src/core/parse/types.js';
import { findCommandColumn } from '../../src/core/parse/parsers/proc.js';
import { splitPipRequirement } from '../../src/core/parse/parsers/pkg.js';
import { MISS_CASES, TURN_CASES } from '../fixtures/turns.js';

function summary(facts: ExtractedFact[]): { predicate: string; subject: string; value?: unknown }[] {
  return facts.map((f) => ({
    predicate: f.predicate,
    subject: f.subject.name,
    value: f.value,
  }));
}

describe('解析器命中（每个 parser ≥ 1 条真实样本）', () => {
  for (const c of TURN_CASES) {
    it(`${c.parser} 抽出 ${String(c.expected.length)} 条事实`, () => {
      const r = parseTurn(c.turn);
      expect(r.produced).toContain(c.parser);
      expect(summary(r.facts)).toEqual(c.expected);
      for (const f of r.facts) {
        expect(f.ext?.['parser']).toBeTypeOf('string');
        expect(f.content.length).toBeGreaterThan(0);
        expect(f.confidence).toBeGreaterThan(0.5);
      }
    });
  }
});

describe('近似样本不该命中（正则写宽的照妖镜）', () => {
  for (const c of MISS_CASES) {
    it(`${c.parser}：${c.why}`, () => {
      const r = parseTurn(c.turn);
      expect(r.produced).not.toContain(c.parser);
    });
  }
});

describe('未识别 → 只落 episode 不入图（概设 §3.2）', () => {
  it('完全无关的命令返回 unparsed，且没有任何事实', () => {
    const r = parseTurn({ tool: 'Bash', cmd: 'echo hello', output: 'hello\n', exitCode: 0 });
    expect(r.facts).toEqual([]);
    expect(r.unparsed).toBe(true);
    expect(r.matched).toEqual([]);
  });

  it('工具名大小写不敏感：Bash / bash / shell 等价', () => {
    const turn = (tool: string): RawTurn => ({
      tool,
      cmd: 'node -v',
      output: 'v22.9.0\n',
      exitCode: 0,
    });
    expect(parseTurn(turn('Bash')).facts).toHaveLength(1);
    expect(parseTurn(turn('bash')).facts).toHaveLength(1);
    expect(parseTurn(turn('SHELL')).facts).toHaveLength(1);
  });

  it('非 shell 工具即使输出一样也不解析', () => {
    const r = parseTurn({ tool: 'Read', cmd: '', output: 'v22.9.0\n', exitCode: 0 });
    expect(r.facts).toEqual([]);
    expect(r.unparsed).toBe(true);
  });
});

describe('同一 turn 内去重', () => {
  it('两条相同的 LISTEN 行只留一条事实', () => {
    const output = [
      'node    48213 john   23u  IPv4 0x7f8a1c2d      0t0  TCP *:8080 (LISTEN)',
      'node    48213 john   23u  IPv4 0x7f8a1c2d      0t0  TCP *:8080 (LISTEN)',
    ].join('\n');
    const r = parseTurn({ tool: 'Bash', cmd: 'lsof -i:8080', output, exitCode: 0 });
    expect(r.facts).toHaveLength(1);
  });

  it('同主体不同取值（两个端口）都保留', () => {
    const output = [
      'node    48213 john   23u  IPv4 0x7f8a1c2d      0t0  TCP *:8080 (LISTEN)',
      'node    48213 john   24u  IPv4 0x7f8a1c2d      0t0  TCP *:8081 (LISTEN)',
    ].join('\n');
    const r = parseTurn({ tool: 'Bash', cmd: 'lsof -i', output, exitCode: 0 });
    expect(r.facts.map((f) => f.subject.name)).toEqual(['8080', '8081']);
  });
});

describe('单个 parser 出错不拖垮整批', () => {
  const boom: Parser = {
    id: 'boom.match',
    tools: [],
    match: () => {
      throw new Error('正则炸了');
    },
    extract: () => [],
  };
  const boomExtract: Parser = {
    id: 'boom.extract',
    tools: [],
    match: () => true,
    extract: () => {
      throw new Error('抽取炸了');
    },
  };

  it('match / extract 抛错都被吞掉，其余 parser 照常工作', () => {
    const registry = new ParserRegistry([boom, boomExtract, ...BUILTIN_PARSERS]);
    const r = registry.parse({ tool: 'Bash', cmd: 'node -v', output: 'v22.9.0\n', exitCode: 0 });
    expect(r.facts).toHaveLength(1);
    expect(r.produced).toEqual(['ver.node']);
  });
});

describe('content 模板（详设 §5.3）', () => {
  it('登记了中文标签就用标签', () => {
    expect(buildContent({ name: 'node', type: 'pkg' }, 'installed_version', '22.9.0')).toBe(
      'node 的安装版本为 22.9.0',
    );
  });

  it('没登记标签退回机器话，不丢事实', () => {
    expect(buildContent({ name: 'x', type: 'concept' }, 'weird_predicate', 1)).toBe(
      'x weird_predicate 1',
    );
  });

  it('对象取值取前三个键，长值截断', () => {
    expect(describeValue({ a: 1, b: 2, c: 3, d: 4 })).toBe('a=1, b=2, c=3');
    expect(describeValue('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('十六个谓词都有中文标签', () => {
    for (const p of [
      'installed_version',
      'runtime_version',
      'version',
      'package_manager',
      'git_branch',
      'git_sync_state',
      'git_head',
      'occupied_by',
      'running',
      'port_conflict',
      'exists',
      'build_result',
      'typecheck_result',
      'test_result',
      'env_var',
      'container_running',
    ]) {
      expect(predicateLabel(p)).toBeTypeOf('string');
    }
  });
});

describe('解析细节', () => {
  it('pip 的 name-version 拆分：名字里的连字符不误伤', () => {
    expect(splitPipRequirement('charset-normalizer-3.3.2')).toEqual(['charset-normalizer', '3.3.2']);
    expect(splitPipRequirement('requests-2.31.0')).toEqual(['requests', '2.31.0']);
    expect(splitPipRequirement('no-version-here')).toBeNull();
  });

  it('ps 表头决定 CMD 列位置（aux 与 -ef 差 3 列）', () => {
    expect(findCommandColumn('USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND')).toEqual({
      pid: 1,
      cmd: 10,
    });
    expect(findCommandColumn('UID PID PPID C STIME TTY TIME CMD')).toEqual({ pid: 1, cmd: 7 });
    expect(findCommandColumn('nothing useful')).toBeNull();
  });

  it('注册表 id 唯一（重复 id 会让日志无法定位规则）', () => {
    const ids = BUILTIN_PARSERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(21);
  });
});
