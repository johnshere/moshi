/**
 * 社区划分与稳定性（P2-11 / 详设 §8.4 D14、概设 §9.2、§10.2.1）。
 *
 * 分层说明：本文件是**纯算法层**——不持 db 句柄、不拼 SQL（lint:lifecycle 红线）。
 * 图数据与写回分别由 `infra/sqlite/communityRepo.ts` 的 `loadCommunityGraph` /
 * `loadOldAssignment` / `applyCommunityAssignment` 承担，本文件只做：
 *
 *   1. **确定性 Louvain**：节点按 id 升序访问、边按 (src,dst) 排序、ΔQ 平局取
 *      社区代表（社区内最小节点 id）较小者。同一份输入必然产出同一份划分
 *      （重跑确定性是验收项）。
 *   2. **Jaccard ≥ 0.5 继承旧 id**（D14）：新旧划分按成员集合算 Jaccard，
 *      一个旧社区最多被一个新社区继承（一对一）；未继承的新社区分配
 *      `max(旧 id)+1` 起递增的新 id，**避开全部旧 id**——消失的旧 id 不复用，
 *      归档 `topic_id` 与 slug 才能长期稳定（否则归档 slug 每次重算都变、
 *      链接全断，这是"归档反复改名"风险的根因）。
 *   3. **模块度**：返回最终划分的 modularity（概设 §10.2.1 图质量指标，
 *      P2-18 诊断面板消费，不落库）。
 *
 * 输入口径（与 progress P2-11 开工核查一致）：只取 active/disputed 事实与
 * 活跃边（valid_to IS NULL 且两端都在参与集合内）；孤立节点各自成社区
 * （标准 Louvain 行为——无边的节点不会并入任何社区）。
 *
 * 算法来源决策（台账 §5.2 D-121 待记）：自实现确定性 Louvain，不引入
 * graphology / graphology-communities-louvain 依赖——根工程没有该依赖，
 * UI workspace 的 graphology 只是传递依赖不能当后端依赖用；且确定性遍历
 * 顺序只能自实现保证。模块度增益用 Blondel et al. 简化公式：
 *   ΔQ(C) = k_in(C)/(2m) − Σ_tot(C)·k_i/(2m²)
 * （自环项在移入/移出中抵消；Σ_tot 为候选社区当前带权度，不含被移动节点）。
 */

export interface CommunityEdge {
  src: string;
  dst: string;
  /** 边权（edge.weight，默认 1.0） */
  weight: number;
}

export interface CommunityGraphInput {
  /** 参与划分的全部 fact id（active/disputed） */
  nodes: readonly string[];
  /** 活跃边：两端都必须在 nodes 内 */
  edges: readonly CommunityEdge[];
  /** 旧分配：fact_id → community_id（仅非空行；空 Map 表示首次划分） */
  oldAssignment: ReadonlyMap<string, number>;
}

export interface CommunityResult {
  /** fact_id → community_id（全部 nodes 都有值，含孤立节点的单节点社区） */
  assignment: ReadonlyMap<string, number>;
  /** 新社区 id → 继承的旧社区 id；无继承的新社区不在表里 */
  inherited: ReadonlyMap<number, number>;
  /** 参与划分的全部旧社区 id（新 id 必须避开的集合） */
  oldCommunityIds: readonly number[];
  /** 新社区 id → 成员数（供归档/诊断用） */
  sizes: ReadonlyMap<number, number>;
  /** Louvain 最终模块度（概设 §10.2.1 指标；< 0.3 视为社区结构瓦解） */
  modularity: number;
  /** Louvain 迭代轮数（聚合轮数，诊断用） */
  iterations: number;
}

/** 节点 id 比较：ULID 字符串可直接字典序（确定性排序的基础） */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 确定性 Louvain。
 *
 * 社区用"代表节点 id"标识：社区内 id 最小的节点。社区标识天然可排序、
 * 可确定性比较，不需要为聚合阶段发明新的编号。
 *
 * 结构：
 * - 邻接表：Map<node, Map<neighbor, weight>>，无向对称；
 * - 局部移动：每轮按节点 id 升序完整扫一遍，有移动就再来一轮（最多 MAX_PASSES）；
 *   单次移动只考虑邻居社区，ΔQ ≤ 0 不移动，ΔQ 平局取社区代表 id 较小者；
 * - 聚合：社区并成超节点，社区间边权合并、社区内边权 ×2 成自环；
 * - 停止：某轮局部移动无任何移动（收敛），或只剩一个社区，或达到外层上限。
 */
function louvain(
  nodes: readonly string[],
  edges: readonly CommunityEdge[],
): { communityOf: ReadonlyMap<string, string>; modularity: number; iterations: number } {
  // ── 建邻接表（无向、对称）──
  const adj = new Map<string, Map<string, number>>();
  const degree = new Map<string, number>();
  let m = 0;
  for (const n of nodes) {
    adj.set(n, new Map());
    degree.set(n, 0);
  }
  // 边按 (src,dst) 排序：保证聚合阶段边合并顺序确定
  const sortedEdges = [...edges].sort((a, b) => byId(a.src, b.src) || byId(a.dst, b.dst));
  for (const e of sortedEdges) {
    if (!adj.has(e.src) || !adj.has(e.dst)) continue; // 防御：输入已保证两端在 nodes 内
    const w = e.weight > 0 ? e.weight : 1;
    const srcNbr = adj.get(e.src)!;
    const dstNbr = adj.get(e.dst)!;
    srcNbr.set(e.dst, (srcNbr.get(e.dst) ?? 0) + w);
    dstNbr.set(e.src, (dstNbr.get(e.src) ?? 0) + w);
    degree.set(e.src, (degree.get(e.src) ?? 0) + w);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + w);
    m += w;
  }

  // 无节点或无边的退化图：每个节点各自成社区，模块度 0
  if (nodes.length === 0 || m <= 0) {
    const communityOf = new Map<string, string>();
    for (const n of [...nodes].sort(byId)) communityOf.set(n, n);
    return { communityOf, modularity: 0, iterations: 0 };
  }

  const MAX_PASSES = 50;
  const MAX_ITERATIONS = 60;
  let iterations = 0;

  // 当前图（超节点级）：节点、邻接、带权度；members：超节点 → 原始 fact id
  let superNodes = [...nodes].sort(byId);
  let curAdj = adj;
  let curDegree = degree;
  let members = new Map<string, string[]>(superNodes.map((n) => [n, [n]]));

  for (let outer = 0; outer < MAX_ITERATIONS; outer += 1) {
    iterations = outer + 1;

    // ── 局部移动阶段 ──
    let communityOf = new Map<string, string>(superNodes.map((n) => [n, n]));
    let communityTot = new Map<string, number>();
    for (const n of superNodes) {
      const d = curDegree.get(n) ?? 0;
      communityTot.set(n, d);
    }

    let movedAny = true;
    let passes = 0;
    while (movedAny && passes < MAX_PASSES) {
      movedAny = false;
      passes += 1;
      for (const node of superNodes) {
        const nodeDegree = curDegree.get(node) ?? 0;
        if (nodeDegree <= 0) continue; // 无权重节点：留在原社区
        const neigh = curAdj.get(node) ?? new Map<string, number>();

        // 候选社区：邻居所在社区（按邻居 id 升序去重收集），并算 k_in
        const kInByCommunity = new Map<string, number>();
        for (const [nbr, w] of neigh) {
          if (nbr === node) continue;
          const c = communityOf.get(nbr);
          if (c === undefined) continue;
          kInByCommunity.set(c, (kInByCommunity.get(c) ?? 0) + w);
        }
        const current = communityOf.get(node)!;
        kInByCommunity.delete(current); // 不评估"留在原地"（ΔQ=0 基准）

        // 找 ΔQ 最大的目标社区；平局取社区代表 id 较小者
        let best: string | null = null;
        let bestDelta = 0;
        const twoM = 2 * m;
        for (const [c, kIn] of kInByCommunity) {
          const sigTot = communityTot.get(c) ?? 0;
          const delta = kIn / twoM - (sigTot * nodeDegree) / (twoM * twoM);
          if (best === null || delta > bestDelta + 1e-12 || (Math.abs(delta - bestDelta) <= 1e-12 && c < best)) {
            best = c;
            bestDelta = delta;
          }
        }

        if (best !== null && bestDelta > 1e-12 && best !== current) {
          // 移动并同步社区带权度
          communityOf.set(node, best);
          communityTot.set(current, (communityTot.get(current) ?? 0) - nodeDegree);
          communityTot.set(best, (communityTot.get(best) ?? 0) + nodeDegree);
          movedAny = true;
        }
      }
    }

    // ── 当前划分（超节点 → 社区）→ 原始节点级 ──
    const rawMembers = new Map<string, string[]>();
    for (const [superNode, c] of communityOf) {
      const list = rawMembers.get(c) ?? [];
      list.push(...(members.get(superNode) ?? []));
      rawMembers.set(c, list);
    }
    const modularity = computeModularity(rawMembers, adj, degree, m);

    // ── 聚合 ──
    const newSuperNodes = [...new Set(communityOf.values())].sort(byId);
    const newMembers = new Map<string, string[]>();
    for (const sn of newSuperNodes) {
      const list: string[] = [];
      for (const [node, c] of communityOf) {
        if (c === sn) list.push(...(members.get(node) ?? []));
      }
      list.sort(byId);
      newMembers.set(sn, list);
    }
    const newAdj = new Map<string, Map<string, number>>();
    const newDegree = new Map<string, number>();
    for (const sn of newSuperNodes) {
      newAdj.set(sn, new Map());
      newDegree.set(sn, 0);
    }
    for (const [u, nbrs] of curAdj) {
      const cu = communityOf.get(u);
      if (cu === undefined) continue;
      for (const [v, w] of nbrs) {
        const cv = communityOf.get(v);
        if (cv === undefined) continue;
        const add = (a: string, b: string): void => {
          const target = newAdj.get(a)!;
          target.set(b, (target.get(b) ?? 0) + w);
          newDegree.set(a, (newDegree.get(a) ?? 0) + w);
        };
        if (cu === cv) {
          // 社区内边 → 自环 ×2（Louvain 约定：内部边对 degree 贡献 2w）
          add(cu, cu);
          add(cu, cu);
        } else if (cu < cv) {
          add(cu, cv);
          add(cv, cu);
        }
      }
    }

    // ── 停止判断 ──
    if (!movedAny && newSuperNodes.length === superNodes.length) {
      // 无移动且聚合无变化：收敛
      return { communityOf: flatten(communityOf, members), modularity, iterations };
    }
    if (newSuperNodes.length === 1) {
      // 全图并成一个社区：全部节点映射到唯一社区
      const finalMap = new Map<string, string>();
      for (const [superNode] of members) finalMap.set(superNode, newSuperNodes[0]!);
      return { communityOf: flatten(finalMap, members), modularity, iterations };
    }

    superNodes = newSuperNodes;
    curAdj = newAdj;
    curDegree = newDegree;
    members = newMembers;
  }

  // 外层硬上限兜底：返回最后一次聚合后的划分（每超节点一社区）
  const fallback = new Map<string, string>(superNodes.map((n) => [n, n]));
  return {
    communityOf: flatten(fallback, members),
    modularity: computeModularity(members, adj, degree, m),
    iterations,
  };
}

/** 超节点级映射 → 原始节点级映射 */
function flatten(
  communityOf: ReadonlyMap<string, string>,
  members: ReadonlyMap<string, string[]>,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [superNode, c] of communityOf) {
    for (const orig of members.get(superNode) ?? []) out.set(orig, c);
  }
  return out;
}

/**
 * 模块度（无向带权，原始图口径）：
 *   Q = Σ_c [ Σ_in(c)/(2m) − (Σ_tot(c)/(2m))² ]
 * Σ_in(c) = 社区内边权重和 ×2，Σ_tot(c) = 社区内节点带权度和。
 */
function computeModularity(
  membersByCommunity: ReadonlyMap<string, readonly string[]>,
  adj: ReadonlyMap<string, ReadonlyMap<string, number>>,
  degree: ReadonlyMap<string, number>,
  m: number,
): number {
  if (m <= 0) return 0;
  let q = 0;
  const twoM = 2 * m;
  for (const [, members] of membersByCommunity) {
    let sumIn = 0;
    let sumTot = 0;
    const inSet = new Set(members);
    for (const node of members) {
      sumTot += degree.get(node) ?? 0;
      const nbrs = adj.get(node);
      if (nbrs === undefined) continue;
      for (const [nbr, w] of nbrs) {
        if (inSet.has(nbr)) sumIn += w;
      }
    }
    q += sumIn / twoM - (sumTot / twoM) ** 2;
  }
  return q;
}

/**
 * 稳定性映射：新社区 ↔ 旧社区按成员集合 Jaccard 一对一匹配（D14）。
 *
 * - 对新社区与每个旧社区算 Jaccard = |A∩B| / |A∪B|（成员为原始 fact id）；
 * - 继承条件：Jaccard ≥ 0.5 且该旧社区未被其它新社区继承（一对一）；
 * - 匹配顺序确定：新社区按代表节点 id 升序，每个新社区按 Jaccard 降序
 *   （平局旧社区 id 升序）尝试；
 * - 未继承的新社区分配 `max(旧 id)+1` 起递增的新 id，避开全部旧 id
 *   （消失的旧 id 不复用，归档 topic_id 长期稳定）。
 */
export function assignStableIds(
  communityOf: ReadonlyMap<string, string>,
  oldAssignment: ReadonlyMap<string, number>,
): {
  assignment: ReadonlyMap<string, number>;
  inherited: ReadonlyMap<number, number>;
  oldCommunityIds: readonly number[];
} {
  // 新社区成员集合：社区代表 → 成员（排序保证集合稳定）
  const membersByCommunity = new Map<string, string[]>();
  for (const [factId, c] of communityOf) {
    const list = membersByCommunity.get(c) ?? [];
    list.push(factId);
    membersByCommunity.set(c, list);
  }
  const newCommunities = [...membersByCommunity.keys()].sort(byId);

  // 旧分配按 fact 归类：旧社区 → 成员集合
  const oldMembers = new Map<number, string[]>();
  for (const [factId, cid] of oldAssignment) {
    const list = oldMembers.get(cid) ?? [];
    list.push(factId);
    oldMembers.set(cid, list);
  }
  const oldCommunityIds = [...oldMembers.keys()].sort((a, b) => a - b);

  // 一对一匹配（Jaccard ≥ 0.5）；匹配阶段用社区代表（string）作 key，
  // 数字 id 分配完成后再映射到 `inherited: Map<number, number>`。
  const inheritedByRep = new Map<string, number>(); // 社区代表 → 旧社区 id
  const usedOld = new Set<number>();
  for (const nc of newCommunities) {
    const members = membersByCommunity.get(nc)!;
    const scored: { oldId: number; j: number }[] = [];
    for (const [oldId, oldMembersList] of oldMembers) {
      const oldSet = new Set(oldMembersList);
      let inter = 0;
      for (const f of members) if (oldSet.has(f)) inter += 1;
      const union = members.length + oldMembersList.length - inter;
      scored.push({ oldId, j: union === 0 ? 0 : inter / union });
    }
    scored.sort((a, b) => b.j - a.j || a.oldId - b.oldId);
    for (const { oldId, j } of scored) {
      if (j >= 0.5 && !usedOld.has(oldId)) {
        inheritedByRep.set(nc, oldId);
        usedOld.add(oldId);
        break;
      }
    }
  }

  // 数字 id 分配：继承的用旧 id；未继承的从 max(旧 id)+1 递增
  const assignment = new Map<string, number>();
  const inherited = new Map<number, number>();
  const maxOld = oldCommunityIds.length > 0 ? (oldCommunityIds[oldCommunityIds.length - 1] as number) : 0;
  let counter = 0;
  const nextNewId = (): number => maxOld + 1 + counter++;
  for (const nc of newCommunities) {
    const inheritedOld = inheritedByRep.get(nc);
    const cid = inheritedOld ?? nextNewId();
    if (inheritedOld !== undefined) inherited.set(cid, inheritedOld);
    for (const factId of membersByCommunity.get(nc)!) assignment.set(factId, cid);
  }

  return { assignment, inherited, oldCommunityIds };
}

/** 入口：整轮社区划分（确定性 Louvain + 稳定性 id 分配） */
export function recomputeCommunities(input: CommunityGraphInput): CommunityResult {
  const { communityOf, modularity, iterations } = louvain(input.nodes, input.edges);
  const { assignment, inherited, oldCommunityIds } = assignStableIds(communityOf, input.oldAssignment);

  const sizes = new Map<number, number>();
  for (const cid of assignment.values()) sizes.set(cid, (sizes.get(cid) ?? 0) + 1);

  return { assignment, inherited, oldCommunityIds, sizes, modularity, iterations };
}
