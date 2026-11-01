/**
 * 嵌入模型的唯一权威定义。
 *
 * 库表 `fact_vec` 的 vec0 维度、sidecar 启动参数、config 默认值都从这里取；
 * 改模型 = 改这两个常量 + 跑迁移（`fact_vec` 会按 meta.vec_dim 重建并重编码）。
 *
 * 为什么是 512 维：bge-small-zh-v1.5 的隐藏维就是 512。Phase 0/P1 早期的
 * 384 维是"P1-02 换模型前"的占位值，真实模型接上后必须一致（详见台账 D-61）。
 */
export const EMBED_DIM = 512;

/** sidecar 加载的模型标识（写进 health/ready 文件，供 /api/status 展示）。 */
export const EMBED_MODEL = 'BAAI/bge-small-zh-v1.5';
