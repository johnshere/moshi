/**
 * P2-11 社区划分与稳定性（详设 §8.4 D14、概设 §9.2）。
 *
 * 验收口径（progress P2-11 / 台账 §4）：
 * - 两个明显连通分量 → 不同社区；孤立节点各自成社区；
 * - 数据微变后大部分社区 id 不变（新旧 Jaccard ≥ 0.5 继承旧 id）；
 * - Jaccard 冲突时一对一分配，未继承的新社区避开全部旧 id；
 * - 失效节点/失效边被排除出图输入；
 * - 同一输入重跑结果完全一致（确定性）；
 * - 写回：community_id 落库、community_rev 推进、无变化不推进；
 * - 10k 事实 < 60s；
 * - daemon runner 按 schema_rev / 活跃边数判脏。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assignStableIds,
  recomputeCommunities,
  type CommunityGraphInput,
} from '../../src/core/lifecycle/community.js';
import { startCommunityRunner } from '../../src/app/communityRunner.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import {
  applyCommunityAssignment,
  communityRev,
  countCommunityChanges,
  loadCommunityGraph,
  loadOldAssignment,
} from '../../src/infra/sqlite/communityRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertEdge, insertFact, makeEntity } from '../fixtures/factories.js';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-community-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

/** 用固定 id 造一个节点（确定性排序依赖 id 字典序） */
function seedNode(db: Db, id: string): void {
  const entityId = makeEntity(db, `pkg-${id}`);
  insertFact(db, {
    id,
    subject: { entity_id: entityId, name: `node-${id}` },
    predicate: 'version',
    value: id,
  });
}

/** 造两个完全连接的团 A（f-a1..a3）与 B（f-b1..b3），外加孤立节点 f-c1 */
function seedTwoCliquesAndIsolated(db: Db): void {
  const a = ['f-a1', 'f-a2', 'f-a3'];
  const b = ['f-b1', 'f-b2', 'f-b3'];
  for (const id of [...a, ...b, 'f-c1']) seedNode(db, id);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = i + 1; j < a.length; j += 1) insertEdge(db, a[i]!, a[j]!);
  }
  for (let i = 0; i < b.length; i += 1) {
    for (let j = i + 1; j < b.length; j += 1) insertEdge(db, b[i]!, b[j]!);
  }
}

function assignmentOf(db: Db): Map<string, number> {
  const rows = db
    .prepare('SELECT id, community_id FROM fact WHERE community_id IS NOT NULL ORDER BY id')
    .all() as { id: string; community_id: number }[];
  return new Map(rows.map((r) => [r.id, r.community_id]));
}

describe('P2-11 社区划分：确定性 Louvain', () => {
  it('两个明显连通分量分到不同社区，孤立节点各自成社区', () => {
    const db = freshDb();
    seedTwoCliquesAndIsolated(db);

    const input = loadCommunityGraph(db);
    expect(input.nodes).toHaveLength(7);
    expect(input.edges).toHaveLength(6);

    const result = recomputeCommunities(input);
    // 三个社区：A 团、B 团、孤立 c1
    expect(result.sizes.size).toBe(3);
    const byMember = new Map<string, number>();
    for (const [factId, cid] of result.assignment) {
      byMember.set(factId, cid);
      expect(cid).toBeGreaterThanOrEqual(0);
    }
    // A 团成员同社区、B 团成员同社区、两者不同社区
    expect(byMember.get('f-a1')).toBe(byMember.get('f-a2'));
    expect(byMember.get('f-a2')).toBe(byMember.get('f-a3'));
    expect(byMember.get('f-b1')).toBe(byMember.get('f-b2'));
    expect(byMember.get('f-b2')).toBe(byMember.get('f-b3'));
    expect(byMember.get('f-a1')).not.toBe(byMember.get('f-b1'));
    // 孤立节点单独一个社区
    const c1 = byMember.get('f-c1')!;
    expect(result.sizes.get(c1)).toBe(1);
    // 全部节点都有归属
    expect(result.assignment.size).toBe(7);
  });

  it('孤立节点社区：成员集合恰为该节点本身', () => {
    const input: CommunityGraphInput = {
      nodes: ['iso-1', 'iso-2'],
      edges: [],
      oldAssignment: new Map(),
    };
    const result = recomputeCommunities(input);
    expect(result.sizes.size).toBe(2);
    expect(result.assignment.get('iso-1')).not.toBe(result.assignment.get('iso-2'));
  });

  it('同一输入重跑结果完全一致（确定性）', () => {
    const db = freshDb();
    seedTwoCliquesAndIsolated(db);
    const input = loadCommunityGraph(db);
    const first = recomputeCommunities(input);
    const second = recomputeCommunities(input);
    expect([...second.assignment.entries()].sort()).toEqual([...first.assignment.entries()].sort());
    expect(second.modularity).toBeCloseTo(first.modularity, 12);
  });

  it('全图并成一个社区时模块度与成员正确', () => {
    // 两个节点一条边 → 一个社区，Q = 0（单社区无结构）
    const input: CommunityGraphInput = {
      nodes: ['n1', 'n2'],
      edges: [{ src: 'n1', dst: 'n2', weight: 1 }],
      oldAssignment: new Map(),
    };
    const result = recomputeCommunities(input);
    expect(result.sizes.size).toBe(1);
    expect(result.assignment.get('n1')).toBe(result.assignment.get('n2'));
    expect(result.modularity).toBeCloseTo(0, 9);
  });
});

describe('P2-11 社区划分：Jaccard 稳定性（D14）', () => {
  it('数据微变后大部分社区 id 不变（Jaccard ≥ 0.5 继承）', () => {
    const db = freshDb();
    seedTwoCliquesAndIsolated(db);

    // 第一轮划分写回
    const first = recomputeCommunities(loadCommunityGraph(db));
    expect(applyCommunityAssignment(db, first.assignment)).toBe(7);
    expect(communityRev(db)).toBe(1);
    const before = assignmentOf(db);

    // 微变：向 A 团加入一个新节点（并入 A 社区），B 团与孤立节点不动
    const entityId = makeEntity(db, 'pkg-new');
    insertFact(db, {
      id: 'f-a4',
      subject: { entity_id: entityId, name: 'node-new' },
      predicate: 'version',
      value: 'a4',
    });
    insertEdge(db, 'f-a4', 'f-a1');
    insertEdge(db, 'f-a4', 'f-a2');

    const second = recomputeCommunities(loadCommunityGraph(db));
    expect(applyCommunityAssignment(db, second.assignment)).toBe(1); // 只有新节点归属变化
    const after = assignmentOf(db);

    // B 团与孤立节点的 id 必须不变（成员集合完全没动，Jaccard = 1）
    expect(after.get('f-b1')).toBe(before.get('f-b1'));
    expect(after.get('f-c1')).toBe(before.get('f-c1'));
    // A 团成员集合从 3 → 4，Jaccard = 3/4 = 0.75 ≥ 0.5，继承旧 id
    expect(after.get('f-a1')).toBe(before.get('f-a1'));
    // 新节点并入 A 社区
    expect(after.get('f-a4')).toBe(before.get('f-a1'));
  });

  it('Jaccard 冲突时一对一分配：只有一个新社区继承旧 id，另一个避开全部旧 id', () => {
    // 旧社区 X = {a,b,c,d}（id 1）；新划分 P={a,b}、Q={c,d}（各占一半，与 X 的 J 均为 0.5）
    const oldAssignment = new Map<string, number>([
      ['a', 1],
      ['b', 1],
      ['c', 1],
      ['d', 1],
    ]);
    // 社区代表（成员最小 id）：P 的代表是 'a'，Q 的代表是 'c'（按 id 升序 P 先匹配）
    const communityOf = new Map<string, string>([
      ['a', 'a'],
      ['b', 'a'],
      ['c', 'c'],
      ['d', 'c'],
    ]);
    const { assignment, inherited, oldCommunityIds } = assignStableIds(communityOf, oldAssignment);

    expect(oldCommunityIds).toEqual([1]);
    // 一对一：只有一个继承
    expect(inherited.size).toBe(1);
    // P（代表 'a'）先匹配 → 继承旧 id 1
    expect(assignment.get('a')).toBe(1);
    expect(assignment.get('b')).toBe(1);
    // Q（代表 'c'）未继承 → 新 id = max(旧 id)+1 = 2，避开旧 id
    expect(assignment.get('c')).toBe(2);
    expect(assignment.get('d')).toBe(2);
    expect(inherited.get(2)).toBeUndefined();
  });

  it('消失的旧社区 id 不复用（新 id 避开全部旧 id）', () => {
    const oldAssignment = new Map<string, number>([
      ['a', 3],
      ['b', 3],
      ['c', 9],
      ['d', 9],
    ]);
    // 新划分把 a,b 并成一个社区（与旧 id 3 的 J = 1 → 继承 3），c,d 拆成两个独立社区
    const communityOf = new Map<string, string>([
      ['a', 'a'],
      ['b', 'a'],
      ['c', 'c'],
      ['d', 'd'],
    ]);
    const { assignment, inherited, oldCommunityIds } = assignStableIds(communityOf, oldAssignment);

    expect(oldCommunityIds).toEqual([3, 9]);
    expect(assignment.get('a')).toBe(3);
    // c、d 各自独立社区：与旧 id 9 的 J = 1/2 = 0.5？—— 成员 {c} 与 {c,d}：J = 1/2 = 0.5 ≥ 0.5！
    // 继承条件满足，c 应继承旧 id 9。验证这个边界：单成员社区与双成员旧社区的 J = 0.5。
    expect(inherited.has(9)).toBe(true);
    expect(assignment.get('c')).toBe(9);
    // d 未继承 → 新 id 从 max(旧 id 3,9)+1 = 10 起
    expect(assignment.get('d')).toBe(10);
  });

  it('首次划分（无旧分配）时全部 id 从 1 起连续分配', () => {
    const communityOf = new Map<string, string>([
      ['a', 'a'],
      ['b', 'a'],
      ['c', 'c'],
    ]);
    const { assignment, inherited, oldCommunityIds } = assignStableIds(communityOf, new Map());
    expect(oldCommunityIds).toEqual([]);
    expect(inherited.size).toBe(0);
    // 无旧 id：maxOld = 0，新 id 从 1 起
    expect(assignment.get('a')).toBe(1);
    expect(assignment.get('b')).toBe(1);
    expect(assignment.get('c')).toBe(2);
  });
});

describe('P2-11 社区划分：图输入口径与写回', () => {
  it('失效节点与失效边被排除出图输入', () => {
    const db = freshDb();
    seedTwoCliquesAndIsolated(db);
    // 失效一个节点（f-b1），收口一条边（f-a1-f-a2）
    db.prepare("UPDATE fact SET epistemic_status = 'invalidated' WHERE id = 'f-b1'").run();
    db.prepare("UPDATE edge SET valid_to = '2099-01-01T00:00:00.000Z' WHERE src = 'f-a1' AND dst = 'f-a2'").run();

    const input = loadCommunityGraph(db);
    expect(input.nodes).not.toContain('f-b1');
    expect(input.nodes).toContain('f-a1');
    expect(input.edges.some((e) => e.src === 'f-a1' && e.dst === 'f-a2')).toBe(false);
    // b2-b3 仍是活跃边且两端都在集合内
    expect(input.edges.some((e) => e.src === 'f-b2' && e.dst === 'f-b3')).toBe(true);
  });

  it('写回：community_id 落库、community_rev 推进、无变化不推进（幂等）', () => {
    const db = freshDb();
    seedTwoCliquesAndIsolated(db);
    expect(communityRev(db)).toBe(0);

    const input = loadCommunityGraph(db);
    const result = recomputeCommunities(input);
    expect(applyCommunityAssignment(db, result.assignment)).toBe(7);
    expect(communityRev(db)).toBe(1);

    // 重跑：划分不变（确定性）→ wrote = 0，rev 不再推进
    const again = recomputeCommunities(loadCommunityGraph(db));
    expect(applyCommunityAssignment(db, again.assignment)).toBe(0);
    expect(communityRev(db)).toBe(1);

    // 全表核对：每个节点都有社区
    const assigned = assignmentOf(db);
    expect(assigned.size).toBe(7);

    // countCommunityChanges（dryRun 用）与 apply 的写入数一致
    expect(countCommunityChanges(db, again.assignment)).toBe(0);
    expect(countCommunityChanges(db, result.assignment)).toBe(0);
  });

  it('loadOldAssignment 只含非空行；apply 后旧分配与新分配一致', () => {
    const db = freshDb();
    seedTwoCliquesAndIsolated(db);
    expect(loadOldAssignment(db).size).toBe(0);

    const input = loadCommunityGraph(db);
    const result = recomputeCommunities(input);
    applyCommunityAssignment(db, result.assignment);

    const old = loadOldAssignment(db);
    expect(old.size).toBe(7);
    for (const [factId, cid] of result.assignment) {
      expect(old.get(factId)).toBe(cid);
    }
  });
});

describe('P2-11 性能：10k 事实 < 60s（详设 §8.4 / 概设 §1.7）', () => {
  it(
    '10k 节点 + 30k 边全图 Louvain 完成且结果确定',
    () => {
      // 造 10k 节点：每 100 个一组形成团（100 个社区），组间稀疏连接
      const nodes: string[] = [];
      const edges: { src: string; dst: string; weight: number }[] = [];
      const N = 10_000;
      const GROUP = 100;
      for (let i = 0; i < N; i += 1) nodes.push(`n${String(i).padStart(5, '0')}`);
      for (let g = 0; g < N / GROUP; g += 1) {
        const base = g * GROUP;
        for (let i = 0; i < GROUP; i += 1) {
          for (let j = i + 1; j < GROUP; j += 1) {
            edges.push({ src: nodes[base + i]!, dst: nodes[base + j]!, weight: 1 });
          }
        }
      }
      // 组间桥接边（每相邻组 2 条）→ 约 200 条额外边
      for (let g = 0; g < N / GROUP - 1; g += 1) {
        const a = g * GROUP;
        const b = (g + 1) * GROUP;
        edges.push({ src: nodes[a]!, dst: nodes[b]!, weight: 1 });
        edges.push({ src: nodes[a + 1]!, dst: nodes[b + 1]!, weight: 1 });
      }

      const startedAt = performance.now();
      const result = recomputeCommunities({
        nodes,
        edges,
        oldAssignment: new Map(),
      });
      const ms = performance.now() - startedAt;

      expect(result.sizes.size).toBe(100);
      expect(result.assignment.size).toBe(N);
      expect(ms).toBeLessThan(60_000);

      // 确定性复查
      const second = recomputeCommunities({ nodes, edges, oldAssignment: new Map() });
      expect([...second.assignment.entries()].sort()).toEqual([...result.assignment.entries()].sort());
    },
    60_000,
  );
});

describe('P2-11 daemon runner：脏检查', () => {
  it('schema_rev 或活跃边数变化才重算；无变化跳过', () => {
    const db = freshDb();
    seedTwoCliquesAndIsolated(db);
    const runner = startCommunityRunner({ db, intervalMs: 0 });

    // 第一次必跑
    const first = runner.runOnce();
    expect(first).not.toBeNull();
    expect(first!.nodes).toBe(7);
    expect(runner.state().runs).toBe(1);

    // 无变化：跳过
    expect(runner.runOnce()).toBeNull();
    expect(runner.state().runs).toBe(1);

    // 新事实（推高 schema_rev）：重算
    seedNode(db, 'f-a4');
    insertEdge(db, 'f-a4', 'f-a1');
    const second = runner.runOnce();
    expect(second).not.toBeNull();
    expect(second!.nodes).toBe(8);
    expect(runner.state().runs).toBe(2);

    // 只加边不插事实（不推 schema_rev）：仍应重算
    const edgeOnly = freshDb();
    seedTwoCliquesAndIsolated(edgeOnly);
    const edgeRunner = startCommunityRunner({ db: edgeOnly, intervalMs: 0 });
    expect(edgeRunner.runOnce()).not.toBeNull();
    expect(edgeRunner.runOnce()).toBeNull();
    insertEdge(edgeOnly, 'f-a1', 'f-b1'); // 桥接边，不插事实
    expect(edgeRunner.runOnce()).not.toBeNull();
    edgeRunner.stop();

    runner.stop();
  });
});
