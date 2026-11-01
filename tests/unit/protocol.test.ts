/**
 * P2-20 采集协议 v1 单元测试（详设 §5.12.1）。
 *
 * 覆盖：块定位、JSON 解析、字段校验、引用解析、未知版本、畸形块、
 * content 自动生成、AnnotatePayload 转换。
 */
import { describe, expect, it } from 'vitest';
import {
  AnnMalformedError,
  AnnVersionUnknownError,
  BLOCK_ETYPES,
  blockDedupKey,
  extractFromBlock,
  factContentOf,
  findMoshiBlocks,
  parseAnnV1Block,
  parseEdgeRef,
  toAnnotatePayload,
} from '../../src/core/collect/protocol.js';

const NORMAL_BLOCK = `\`\`\`moshi
{"v":1,
 "facts":[{"subject":"daemon","predicate":"port","value":"53000",
           "content":"daemon 监听端口 = 53000","confidence":0.95,"source":"tool_obs"}],
 "edges":[{"from":"k:daemon.port","to":"k:proxy.noproxy","etype":"depends_on",
           "note":"curl 走代理导致回环请求失败"}]}
\`\`\``;

const MULTI_BLOCK = `before
\`\`\`moshi
{"v":1,"facts":[{"subject":"a","predicate":"p1","value":1}],"edges":[]}
\`\`\`
middle
\`\`\`json
{"v":1}
\`\`\`
\`\`\`moshi
{"v":1,"facts":[{"subject":"b","predicate":"p2","value":2}],"edges":[]}
\`\`\`
after`;

const MALFORMED_BLOCK = `\`\`\`moshi
{"v":1, "facts": [}
\`\`\``;

const UNKNOWN_VERSION = `\`\`\`moshi
{"v":99,"facts":[],"edges":[]}
\`\`\``;

describe('采集协议 v1', () => {
  it('定位 ```moshi 块（跨行 JSON）', () => {
    const blocks = findMoshiBlocks(NORMAL_BLOCK);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('daemon 监听端口');
  });

  it('不识别 ```json 围栏', () => {
    const text = '```json\n{"v":1}\n```';
    expect(findMoshiBlocks(text)).toHaveLength(0);
  });

  it('同一段文本可含多个 moshi 块', () => {
    const blocks = findMoshiBlocks(MULTI_BLOCK);
    expect(blocks).toHaveLength(2);
  });

  it('无块时返回空数组', () => {
    expect(findMoshiBlocks('just plain text')).toHaveLength(0);
  });

  it('正常块解析出事实与边', () => {
    const parsed = parseAnnV1Block(NORMAL_BLOCK);
    expect(parsed.block.v).toBe(1);
    expect(parsed.block.facts).toHaveLength(1);
    const f = parsed.block.facts[0]!;
    expect(f.subject).toBe('daemon');
    expect(f.predicate).toBe('port');
    expect(f.value).toBe('53000');
    expect(f.content).toBe('daemon 监听端口 = 53000');
    expect(f.confidence).toBe(0.95);
    expect(f.source).toBe('tool_obs');
    expect(parsed.block.edges).toHaveLength(1);
    const e = parsed.block.edges[0]!;
    expect(e.from).toBe('k:daemon.port');
    expect(e.to).toBe('k:proxy.noproxy');
    expect(e.etype).toBe('depends_on');
    expect(e.note).toContain('代理');
    expect(parsed.blockHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('未知版本整块跳过（抛 AnnVersionUnknownError）', () => {
    expect(() => parseAnnV1Block(UNKNOWN_VERSION)).toThrow(AnnVersionUnknownError);
  });

  it('畸形 JSON 进隔离区语义（抛 AnnMalformedError）', () => {
    expect(() => parseAnnV1Block(MALFORMED_BLOCK)).toThrow(AnnMalformedError);
  });

  it('缺少必填字段视为畸形', () => {
    const block = '```moshi\n{"v":1,"facts":[{"subject":"x"}],"edges":[]}\n```';
    expect(() => parseAnnV1Block(block)).toThrow(AnnMalformedError);
  });

  it('非法 etype 视为畸形', () => {
    const block =
      '```moshi\n{"v":1,"facts":[{"subject":"x","predicate":"p","value":1}],"edges":[{"from":"k:x","to":"k:y","etype":"supersedes"}]}\n```';
    expect(() => parseAnnV1Block(block)).toThrow(AnnMalformedError);
  });

  it('引用解析：f: 与 k:', () => {
    expect(parseEdgeRef('f_abc')).toBeNull();
    expect(parseEdgeRef('f:f_01j9z3k2')).toEqual({ kind: 'fact', id: 'f_01j9z3k2' });
    expect(parseEdgeRef('k:ck1:deadbeef')).toEqual({ kind: 'key', id: 'ck1:deadbeef' });
  });

  it('引用解析不到的边进候选，不丢弃', () => {
    const block =
      '```moshi\n{"v":1,"facts":[{"subject":"x","predicate":"p","value":1}],"edges":[{"from":"bad","to":"k:y","etype":"co_occur"}]}\n```';
    const parsed = parseAnnV1Block(block);
    const extracted = extractFromBlock(parsed);
    expect(extracted.resolved).toHaveLength(0);
    expect(extracted.pending).toHaveLength(1);
    expect(extracted.pending[0]!.fromRaw).toBe('bad');
    expect(extracted.pending[0]!.toRaw).toBe('k:y');
  });

  it('content 缺失时自动生成', () => {
    const f = toAnnotatePayload({ subject: 'node', predicate: 'version', value: '22.22.2' });
    expect(f.content).toBe('node version = 22.22.2');
    expect(f.etype).toBe('unknown');
    expect(f.confidenceSource).toBe('llm_claim');
  });

  it('content 显式提供时保留', () => {
    const fact = factContentOf({ subject: 'a', predicate: 'b', value: 1, content: 'custom' });
    expect(fact).toBe('custom');
  });

  it('块内 facts 与 edges 截断到上限', () => {
    const facts = Array.from({ length: 25 }, (_, i) => ({
      subject: `s${i}`,
      predicate: 'p',
      value: i,
    }));
    const edges = Array.from({ length: 25 }, (_, i) => ({
      from: `f:f${i}`,
      to: `f:f${i + 1}`,
      etype: 'depends_on' as const,
    }));
    const raw = `\`\`\`moshi\n${JSON.stringify({ v: 1, facts, edges })}\n\`\`\``;
    const parsed = parseAnnV1Block(raw);
    const extracted = extractFromBlock(parsed, { maxFacts: 20, maxEdges: 20 });
    expect(extracted.annotations).toHaveLength(20);
    expect(extracted.resolved).toHaveLength(20);
  });

  it('幂等键 = session_id + block_hash', () => {
    const parsed = parseAnnV1Block(
      '```moshi\n{"v":1,"facts":[{"subject":"x","predicate":"p","value":1}],"edges":[]}\n```',
    );
    expect(blockDedupKey('ss_abc', parsed.blockHash)).toBe(`dk-block:ss_abc:${parsed.blockHash}`);
  });

  it('BLOCK_ETYPES 仅含三种调用方可声明的边', () => {
    expect(BLOCK_ETYPES).toEqual(['depends_on', 'co_occur', 'derived_from']);
  });
});
