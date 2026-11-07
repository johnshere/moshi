/**
 * P3-01 / P3-02 子图契约（`moshi-subgraph/2`）单测（详设 §4.5 / §7.2）。
 *
 * 覆盖：常量、字段与边下标映射、options 默认/覆盖、确定性/无副作用、
 * 与 fixture `tests/fixtures/subgraph-contract.json` 深相等、非法输入统一
 * 抛 `MoshiError('E_INPUT')`、数值 clamp、节点/边上限边界；
 * P3-02 追加：`edge_attr` 16 维与 `edgeFeatures()` 一致、`hop` 校验、
 * `direction` 规则（有向 ±1 / 无向 0）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMBED_DIM } from '../../src/domain/embedding.js';
import { edgeFeatures } from '../../src/domain/edgeFeatures.js';
import { MoshiError } from '../../src/domain/errors.js';
import {
  MAX_EDGES,
  MAX_NODES,
  NODE_FEAT_DIM,
  SUBGRAPH_SCHEMA,
  buildSubgraphPayload,
  type MoshiSubgraphPayload,
  type SubgraphEdgeInput,
  type SubgraphNodeInput,
} from '../../src/domain/subgraph.js';

function embedding(pairs: ReadonlyArray<readonly [number, number]>): number[] {
  const out = new Array<number>(EMBED_DIM).fill(0);
  for (const [i, v] of pairs) out[i] = v;
  return out;
}

/** 与 fixture 一致的 3 节点输入（每次返回新对象，避免测试间串改）。 */
function baseNodes(): SubgraphNodeInput[] {
  return [
    {
      factId: 'fact_semantic',
      embedding: embedding([
        [0, 0.6],
        [1, 0.8],
      ]),
      ftype: 'semantic',
      confidence: 0.95,
      importance: 0.6,
      epistemicStatus: 'active',
      degree: 4,
    },
    {
      factId: 'fact_episodic',
      embedding: embedding([
        [0, 0.8],
        [1, -0.6],
      ]),
      ftype: 'episodic',
      confidence: 0.82,
      importance: 0.35,
      epistemicStatus: 'archived',
      degree: 2,
    },
    {
      factId: 'fact_conditional',
      embedding: embedding([
        [1, 0.6],
        [2, 0.8],
      ]),
      ftype: 'conditional',
      confidence: 0.71,
      importance: 0.5,
      epistemicStatus: 'disputed',
      degree: 0,
    },
  ];
}

function baseEdges(): SubgraphEdgeInput[] {
  return [
    {
      srcFactId: 'fact_semantic',
      dstFactId: 'fact_episodic',
      etype: 'depends_on',
      weight: 1.0,
      confidence: 0.7,
      hop: 1,
    },
    {
      srcFactId: 'fact_episodic',
      dstFactId: 'fact_conditional',
      etype: 'co_occur',
      weight: 1.0,
      confidence: 0.9,
      hop: 2,
    },
  ];
}

interface SubgraphFixture {
  schema: string;
  node_feat_dim: number;
  payload: MoshiSubgraphPayload;
}

const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/subgraph-contract.json', import.meta.url), 'utf8'),
) as SubgraphFixture;

function expectEInput(fn: () => unknown, pattern?: RegExp): MoshiError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(MoshiError);
  const err = caught as MoshiError;
  expect(err.code).toBe('E_INPUT');
  if (pattern !== undefined) expect(err.message).toMatch(pattern);
  return err;
}

function build(overrides: Partial<Parameters<typeof buildSubgraphPayload>[0]> = {}): MoshiSubgraphPayload {
  return buildSubgraphPayload({
    queryVector: null,
    nodes: baseNodes(),
    edges: baseEdges(),
    ...overrides,
  });
}

describe('契约常量', () => {
  it('SUBGRAPH_SCHEMA / NODE_FEAT_DIM / MAX_NODES / MAX_EDGES', () => {
    expect(SUBGRAPH_SCHEMA).toBe('moshi-subgraph/2');
    expect(EMBED_DIM).toBe(512);
    expect(NODE_FEAT_DIM).toBe(EMBED_DIM + 10);
    expect(NODE_FEAT_DIM).toBe(522);
    expect(MAX_NODES).toBe(64);
    expect(MAX_EDGES).toBe(192);
  });
});

describe('payload 组装', () => {
  it('3 节点 2 边：schema / query_vector / nodes / edges 字段齐全', () => {
    const payload = build();
    expect(payload.schema).toBe(SUBGRAPH_SCHEMA);
    expect(payload.query_vector).toBeNull();
    expect(payload.nodes).toHaveLength(3);
    expect(payload.edges).toHaveLength(2);
    expect(Object.keys(payload).sort()).toEqual([
      'edges',
      'nodes',
      'options',
      'query_vector',
      'schema',
    ]);

    expect(payload.nodes[0]).toEqual({
      fact_id: 'fact_semantic',
      embedding: embedding([
        [0, 0.6],
        [1, 0.8],
      ]),
      ftype: 'semantic',
      confidence: 0.95,
      importance: 0.6,
      epistemic_status: 'active',
      degree: 4,
    });
    expect(payload.nodes.map((n) => n.fact_id)).toEqual([
      'fact_semantic',
      'fact_episodic',
      'fact_conditional',
    ]);
    expect(Object.keys(payload.nodes[0]!).sort()).toEqual([
      'confidence',
      'degree',
      'embedding',
      'epistemic_status',
      'fact_id',
      'ftype',
      'importance',
    ]);

    expect(payload.edges).toEqual([
      {
        src: 0,
        dst: 1,
        etype: 'depends_on',
        weight: 1,
        confidence: 0.7,
        edge_attr: [1, 0, 0, 0, 0, 0, 1, 0.7, 0.5, 1, 0, 0, 0, 0, 0, 0],
      },
      {
        src: 1,
        dst: 2,
        etype: 'co_occur',
        weight: 1,
        confidence: 0.9,
        edge_attr: [0, 0, 0, 1, 0, 0, 1, 0.9, 1, 0, 0, 0, 0, 0, 0, 0],
      },
    ]);
    expect(Object.keys(payload.edges[0]!).sort()).toEqual([
      'confidence',
      'dst',
      'edge_attr',
      'etype',
      'src',
      'weight',
    ]);
  });

  it('边的 src/dst 按输入节点顺序映射下标（节点换序后下标跟着换）', () => {
    const nodes = baseNodes();
    const reordered = [nodes[2]!, nodes[0]!, nodes[1]!];
    const payload = build({ nodes: reordered });
    expect(payload.nodes.map((n) => n.fact_id)).toEqual([
      'fact_conditional',
      'fact_semantic',
      'fact_episodic',
    ]);
    // 原边 semantic→episodic 现在是 1→2；episodic→conditional 现在是 2→0
    expect(payload.edges.map((e) => [e.src, e.dst])).toEqual([
      [1, 2],
      [2, 0],
    ]);
  });

  it('options 默认 self_attn=false、cross_attn=true，显式值可覆盖', () => {
    expect(build().options).toEqual({ self_attn: false, cross_attn: true });
    expect(build({ options: { selfAttn: true, crossAttn: false } }).options).toEqual({
      self_attn: true,
      cross_attn: false,
    });
    expect(build({ options: {} }).options).toEqual({ self_attn: false, cross_attn: true });
  });

  it('queryVector 透传（不归一化），embedding 复制成新数组（入参无副作用）', () => {
    const query = embedding([
      [0, 0.28],
      [1, 0.96],
    ]);
    const nodes = baseNodes();
    const payload = build({ queryVector: query, nodes });
    expect(payload.query_vector).toEqual(query);
    // 输出 array 与输入 array 不共享引用
    payload.nodes[0]!.embedding![0] = 99;
    expect(nodes[0]!.embedding![0]).toBe(0.6);
    expect(payload.query_vector).not.toBe(query);
  });

  it('每条边的 edge_attr 与 edgeFeatures() 逐条一致（16 维唯一权威）', () => {
    const payload = build();
    expect(payload.edges.map((e) => e.edge_attr)).toEqual([
      edgeFeatures({ etype: 'depends_on', weight: 1, confidence: 0.7, hop: 1, direction: 1 }),
      edgeFeatures({ etype: 'co_occur', weight: 1, confidence: 0.9, hop: 2, direction: 0 }),
    ]);
  });

  it('direction：有向边按下标前进/逆序取 ±1，无向边取 0', () => {
    const nodes = baseNodes();
    const edges: SubgraphEdgeInput[] = [
      {
        srcFactId: 'fact_episodic',
        dstFactId: 'fact_semantic',
        etype: 'supersedes',
        weight: 1,
        confidence: 1,
        hop: 1,
      },
      {
        srcFactId: 'fact_semantic',
        dstFactId: 'fact_conditional',
        etype: 'mutually_exclusive',
        weight: 1,
        confidence: 1,
        hop: 1,
      },
    ];
    const payload = build({ nodes, edges });
    // 有向逆序：fact_episodic(下标 1) → fact_semantic(下标 0) = -1
    expect(payload.edges[0]!.edge_attr[9]).toBe(-1);
    // 无向：下标 0 → 2 仍取 0
    expect(payload.edges[1]!.edge_attr[9]).toBe(0);
  });

  it('同一输入两次构造深相等（确定性）', () => {
    expect(build()).toEqual(build());
  });

  it('节点 64 / 边 192 为上限内合法', () => {
    const node = baseNodes()[0]!;
    const nodes = Array.from({ length: MAX_NODES }, (_, i) => ({ ...node, factId: `fact_${i}` }));
    const edges = Array.from({ length: MAX_EDGES }, () => ({
      srcFactId: 'fact_0',
      dstFactId: 'fact_1',
      etype: 'logic' as const,
      weight: 0.5,
      confidence: 0.5,
      hop: 1 as const,
    }));
    const payload = build({ nodes, edges });
    expect(payload.nodes).toHaveLength(MAX_NODES);
    expect(payload.edges).toHaveLength(MAX_EDGES);
    expect(payload.edges[0]).toEqual({
      src: 0,
      dst: 1,
      etype: 'logic',
      weight: 0.5,
      confidence: 0.5,
      edge_attr: [0, 1, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0],
    });
  });
});

describe('与跨语言 fixture 深相等', () => {
  it('fixture 元数据与 payload 形状', () => {
    expect(FIXTURE.schema).toBe(SUBGRAPH_SCHEMA);
    expect(FIXTURE.node_feat_dim).toBe(NODE_FEAT_DIM);
    expect(FIXTURE.node_feat_dim).toBe(522);
    expect(FIXTURE.payload.schema).toBe(SUBGRAPH_SCHEMA);
    expect(FIXTURE.payload.nodes).toHaveLength(3);
    expect(FIXTURE.payload.edges).toHaveLength(2);
    expect(FIXTURE.payload.query_vector).toBeNull();
    expect(FIXTURE.payload.options).toEqual({ self_attn: false, cross_attn: true });
    // 正式 payload 不包含测试元数据 node_feat_dim
    expect((FIXTURE.payload as unknown as Record<string, unknown>).node_feat_dim).toBeUndefined();
  });

  it('buildSubgraphPayload 输出与 fixture 的 payload 深相等', () => {
    expect(build()).toEqual(FIXTURE.payload);
  });
});

describe('非法输入统一抛 E_INPUT', () => {
  it('节点数 0 / 超过 64', () => {
    expectEInput(() => build({ nodes: [] }), /nodes 数量/);
    const node = baseNodes()[0]!;
    const tooMany = Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ ...node, factId: `fact_${i}` }));
    expectEInput(() => build({ nodes: tooMany }), /nodes 数量/);
  });

  it('边数超过 192', () => {
    const edge = baseEdges()[0]!;
    expectEInput(() => build({ edges: Array.from({ length: MAX_EDGES + 1 }, () => edge) }), /edges 数量/);
  });

  it('factId 为空 / 仅空白 / 重复', () => {
    const nodes = baseNodes();
    expectEInput(() => build({ nodes: [{ ...nodes[0]!, factId: '' }, nodes[1]!, nodes[2]!] }), /factId/);
    expectEInput(() => build({ nodes: [{ ...nodes[0]!, factId: '   ' }, nodes[1]!, nodes[2]!] }), /factId/);
    expectEInput(
      () => build({ nodes: [nodes[0]!, { ...nodes[1]!, factId: 'fact_semantic' }, nodes[2]!] }),
      /重复 factId/,
    );
  });

  it('embedding 必须为 null 或 512 维有限数数组', () => {
    const nodes = baseNodes();
    expectEInput(
      () => build({ nodes: [{ ...nodes[0]!, embedding: new Array<number>(511).fill(0) }, ...nodes.slice(1)] }),
      /embedding.*长度/,
    );
    expectEInput(
      () => build({ nodes: [{ ...nodes[0]!, embedding: new Array<number>(EMBED_DIM).fill(Number.NaN) }, ...nodes.slice(1)] }),
      /embedding\[0\]/,
    );
    expectEInput(
      () =>
        build({
          nodes: [
            { ...nodes[0]!, embedding: new Array<number>(EMBED_DIM).fill(Number.POSITIVE_INFINITY) },
            ...nodes.slice(1),
          ],
        }),
      /embedding\[0\]/,
    );
  });

  it('queryVector 必须为 null 或 512 维有限数数组', () => {
    expectEInput(() => build({ queryVector: new Array<number>(8).fill(0) }), /queryVector.*长度/);
    expectEInput(() => build({ queryVector: new Array<number>(EMBED_DIM).fill(Number.NaN) }), /queryVector\[0\]/);
  });

  it('confidence / importance / weight 必须是有限数', () => {
    const nodes = baseNodes();
    const edges = baseEdges();
    expectEInput(
      () => build({ nodes: [{ ...nodes[0]!, confidence: Number.NaN }, ...nodes.slice(1)] }),
      /confidence/,
    );
    expectEInput(
      () => build({ nodes: [{ ...nodes[0]!, importance: Number.POSITIVE_INFINITY }, ...nodes.slice(1)] }),
      /importance/,
    );
    expectEInput(
      () => build({ edges: [{ ...edges[0]!, weight: Number.NEGATIVE_INFINITY }, edges[1]!] }),
      /weight/,
    );
    expectEInput(
      () => build({ edges: [{ ...edges[0]!, confidence: Number.NaN }, edges[1]!] }),
      /confidence/,
    );
  });

  it('degree 必须是非负整数', () => {
    const nodes = baseNodes();
    expectEInput(
      () => build({ nodes: [{ ...nodes[0]!, degree: -1 }, ...nodes.slice(1)] }),
      /degree/,
    );
    expectEInput(
      () => build({ nodes: [{ ...nodes[0]!, degree: 1.5 }, ...nodes.slice(1)] }),
      /degree/,
    );
  });

  it('未知 ftype / epistemicStatus / etype', () => {
    const nodes = baseNodes();
    const edges = baseEdges();
    expectEInput(
      () =>
        build({
          nodes: [{ ...nodes[0]!, ftype: 'unknown' as SubgraphNodeInput['ftype'] }, ...nodes.slice(1)],
        }),
      /ftype/,
    );
    expectEInput(
      () =>
        build({
          nodes: [
            { ...nodes[0]!, epistemicStatus: 'unknown' as SubgraphNodeInput['epistemicStatus'] },
            ...nodes.slice(1),
          ],
        }),
      /epistemicStatus/,
    );
    expectEInput(
      () =>
        build({
          edges: [{ ...edges[0]!, etype: 'unknown' as SubgraphEdgeInput['etype'] }, edges[1]!],
        }),
      /etype/,
    );
  });

  it('hop 必须是 1 或 2', () => {
    const edges = baseEdges();
    expectEInput(
      () => build({ edges: [{ ...edges[0]!, hop: 0 as unknown as 1 }, edges[1]!] }),
      /hop/,
    );
    expectEInput(
      () => build({ edges: [{ ...edges[0]!, hop: 3 as unknown as 1 }, edges[1]!] }),
      /hop/,
    );
    expectEInput(
      () =>
        build({
          edges: [{ ...edges[0]!, hop: '1' as unknown as 1 }, edges[1]!],
        }),
      /hop/,
    );
  });

  it('边引用的 factId 必须存在于节点集合', () => {
    const edges = baseEdges();
    expectEInput(
      () => build({ edges: [{ ...edges[0]!, srcFactId: 'fact_missing' }, edges[1]!] }),
      /srcFactId/,
    );
    expectEInput(
      () => build({ edges: [{ ...edges[0]!, dstFactId: 'fact_missing' }, edges[1]!] }),
      /dstFactId/,
    );
  });

  it('options 字段必须是布尔值', () => {
    expectEInput(
      () =>
        build({
          options: { selfAttn: 'yes' as unknown as boolean },
        }),
      /options\.selfAttn/,
    );
    expectEInput(
      () =>
        build({
          options: { crossAttn: 1 as unknown as boolean },
        }),
      /options\.crossAttn/,
    );
  });
});

describe('数值 clamp 到 [0,1]', () => {
  it('confidence / importance / weight / 边 confidence 越界被夹紧', () => {
    const nodes = baseNodes();
    const edges = baseEdges();
    const payload = build({
      nodes: [
        { ...nodes[0]!, confidence: -0.5, importance: 1.5 },
        { ...nodes[1]!, confidence: 1.5, importance: -0.5 },
        nodes[2]!,
      ],
      edges: [
        { ...edges[0]!, weight: -2, confidence: 2 },
        edges[1]!,
      ],
    });
    expect(payload.nodes[0]!.confidence).toBe(0);
    expect(payload.nodes[0]!.importance).toBe(1);
    expect(payload.nodes[1]!.confidence).toBe(1);
    expect(payload.nodes[1]!.importance).toBe(0);
    expect(payload.edges[0]!.weight).toBe(0);
    expect(payload.edges[0]!.confidence).toBe(1);
  });
});
