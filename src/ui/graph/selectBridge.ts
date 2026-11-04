/**
 * `window.__moshiGraph.selected` 的发布口（P2-19A-18）。
 *
 * 验收脚本要在一个固定位置读到当前选中集：3D 场景的 `publish()` 每帧都会重写整个
 * `window.__moshiGraph`，所以只需在那里带上 `selected`；2D 视图没有 3D 场景（切到 2D
 * 后 `Graph3D` 卸载、不再 publish），因此 2D 自己把选中集补写进同一个对象。
 *
 * 两条纪律：
 * 1. **只加字段**：不新建 `__moshiSelection` 之类的第二个全局变量，也不改既有字段语义；
 * 2. 深链 `?view=2d` 直接进入时 `__moshiGraph` 还不存在——建一个只含 `selected` 的最小
 *    对象，不让验收脚本因为没有 3D 场景而报 `undefined`（`fps`/`nodeCount` 等 3D 字段
 *    此时本就没有意义，别当 2D 指标读）。
 */
export function publishSelectedIds(ids: readonly string[]): void {
  const carrier = window as unknown as { __moshiGraph?: { selected?: string[] } };
  const target = carrier.__moshiGraph;
  if (target === undefined) {
    carrier.__moshiGraph = { selected: [...ids] };
    return;
  }
  target.selected = [...ids];
}
