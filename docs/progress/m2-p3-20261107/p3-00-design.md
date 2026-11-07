# P3-00 边特征 16 维定义与契约补字段 — 设计

状态：设计已定，待实施
目标：补契约洞——模型签名 `edge_dim=16` 但边特征从未定义；本次定义逐维语义、TS 侧实现、契约测试骨架。

## 16 维（详设 §4.5 已定，P3-00 补实现与测试）

| 下标 | 含义 |
| --- | --- |
| 0–5 | `etype` one-hot，顺序 `depends_on, logic, mutually_exclusive, co_occur, supersedes, derived_from` |
| 6 | `weight`，0–1，缺省 1.0 |
| 7 | `confidence`，0–1 |
| 8 | `hop`：1 跳→0.5，2 跳→1.0，非路径边→0 |
| 9 | 方向：src→dst 为 +1，逆序 −1，无向 0 |
| 10–15 | 保留，恒 0，永不复用 |

合计 16。白名单只允许 `etype/weight/confidence/hop/方向`；禁入 `strength/pool/access_count/last_access_at/archive_meta.*/layout.*/community_summary.derived_at`。

## 改动

1. `src/domain/edgeFeatures.ts`（新）
   - `export const EDGE_FEAT_DIM = 16;`
   - `export const EDGE_RESERVED_FROM = 10;`
   - `export interface EdgeFeatureInput { etype: Etype; weight: number; confidence: number; hop: 1 | 2 | null; direction: 1 | -1 | 0; }`
   - `export function edgeFeatures(input): number[]`：长度 16；one-hot 用 `ETYPE.indexOf`；weight/confidence clamp 到 [0,1]；hop 按上表；reserved 全 0；未知 etype 抛 `E_SCHEMA`/`E_INPUT` 类的明确错误。
   - `export function edgeFeaturesPadded(edges, maxEdges=192): number[][]`：不足补全 0；超过截断；供契约测试/后续 P3-02 复用。
   - 不读 DB、不查边；纯函数。方向由调用方传入（P3-01 负责把 src/dst 下标转方向）。
2. `tests/unit/edgeFeatures.test.ts`
   - 6 种 etype 各断言 one-hot；
   - weight/confidence 边界 0/1/越界 clamp；
   - hop 1/2/null；direction 1/-1/0；
   - reserved 10–15 全 0；
   - padding 到 192 的行全 0；截断；
   - 禁入字段：函数入参不包含这些字段（白名单由类型 + 测试对象 key 断言）。
3. `sidecar/tests/test_contract.py`（骨架，P3-01 扩展）
   - 读取 `tests/fixtures/edge-features.json`（由 TS 单测生成的固定 2 边样例）或内联 fixture；
   - 断言 Python `np.asarray(edge_attr).shape == (1, 192, 16)`、padding 行全 0；
   - P3-00 阶段不依赖 `features.py`/model；只验契约字段。P3-01 再加真实 Node→Python 子图契约。
4. `docs/详设.md` §4.5：确认 16 维表与实现一致；若需补“方向由下标差决定”的说明，只补说明不改数字。

## 边界

- 不建 model、不写 `features.py` 的节点 522 维拼接（P3-02）。
- 不改 `src/core/read/subgraph.ts` 的 BFS/排序；P3-01 在它之上做契约。
- 不碰 I-49 的 conflict/adjudication 文件。
- 不写死 522；本卡只碰边 16 维。
