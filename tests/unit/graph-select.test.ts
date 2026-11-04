/**
 * 2D 框选多选（P2-19A-18）的纯函数 + 共享选中态测试。
 *
 * 覆盖三件"算错了也看不出来"的事：
 * 1. 屏幕矩形 → 图坐标矩形必须走相机逆变换（不是按像素比例缩放）；
 * 2. 框内判定与选中集合并的边界（边界命中、Shift 合并、替换清空）；
 * 3. `useSelection` 的批量写入口径（focusId 取最后一个、空框替换清空、Esc=clear）。
 *
 * 不测 DOM/sigma：拖拽手势本身留给浏览器验收（`window.__moshiGraph.selected` 读数）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD_PX,
  beginDrag,
  boxContainsPoint,
  boxFromPoints,
  dragScreenBox,
  focusAfterBox,
  mergeSelection,
  screenBoxToWorld,
  selectIdsInBox,
  updateDrag,
  type Point,
} from '../../src/ui/graph/pure/select.js';
import { useSelection } from '../../src/ui/state/selection.js';

function resetSelection(): void {
  useSelection.setState({ selectedIds: new Set<string>(), focusId: null });
}

beforeEach(resetSelection);

describe('框选几何', () => {
  it('两个对角点任意顺序都归一化成同一个 Box', () => {
    const a = boxFromPoints({ x: 10, y: 5 }, { x: -2, y: 9 });
    const b = boxFromPoints({ x: -2, y: 9 }, { x: 10, y: 5 });
    expect(a).toEqual({ x0: -2, y0: 5, x1: 10, y1: 9 });
    expect(b).toEqual(a);
  });

  it('boxContainsPoint：边界算命中，pad 扩容差', () => {
    const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(boxContainsPoint(box, { x: 0, y: 0 })).toBe(true);
    expect(boxContainsPoint(box, { x: 10, y: 10 })).toBe(true);
    expect(boxContainsPoint(box, { x: 10.01, y: 5 })).toBe(false);
    expect(boxContainsPoint(box, { x: 10.01, y: 5 }, 0.5)).toBe(true);
  });

  it('屏幕矩形经 viewportToGraph 逆变换，不按像素比例缩放', () => {
    // 假相机：屏幕 (100,100) → 图 (10,10)，屏幕 (300,200) → 图 (30,20)——y 方向比例不同，
    // 用来证明两个角都做了逆变换。
    const view = {
      viewportToGraph: (p: Point): Point => ({ x: p.x / 10, y: p.y / 10 + (p.y > 150 ? 1 : 0) }),
    };
    const box = screenBoxToWorld(view, { x: 300, y: 200 }, { x: 100, y: 100 });
    expect(box.x0).toBeCloseTo(10);
    expect(box.x1).toBeCloseTo(30);
    // 逆变换两个角的 y 分别是 10 与 21（第二角命中了 +1 分支）
    expect(box.y0).toBeCloseTo(10);
    expect(box.y1).toBeCloseTo(21);
  });

  it('selectIdsInBox：只收框内节点，顺序与入参一致', () => {
    const nodes = [
      { id: 'a', x: 1, y: 1 },
      { id: 'b', x: 9, y: 9 },
      { id: 'c', x: 50, y: 50 },
      { id: 'd', x: 0, y: 0 },
    ];
    expect(selectIdsInBox(nodes, boxFromPoints({ x: 0, y: 0 }, { x: 10, y: 10 }))).toEqual([
      'a',
      'b',
      'd',
    ]);
    expect(selectIdsInBox(nodes, boxFromPoints({ x: 49, y: 49 }, { x: 51, y: 51 }))).toEqual(['c']);
    expect(selectIdsInBox(nodes, boxFromPoints({ x: 100, y: 100 }, { x: 101, y: 101 }))).toEqual([]);
  });

  it('拖拽阈值：未越过阈值不算框选，越过一次后抖回起点也不倒退', () => {
    const drag = beginDrag({ x: 100, y: 100 }, false);
    const tiny = updateDrag(drag, { x: 100 + DRAG_THRESHOLD_PX - 1, y: 100 });
    expect(tiny.moved).toBe(false);

    const moved = updateDrag(drag, { x: 100 + DRAG_THRESHOLD_PX, y: 100 });
    expect(moved.moved).toBe(true);

    const back = updateDrag(moved, { x: 100, y: 100 });
    expect(back.moved).toBe(true); // 已经进入框选，不会因为抖回起点变回"点击"
    expect(dragScreenBox(back)).toEqual({ x0: 100, y0: 100, x1: 100, y1: 100 });
  });
});

describe('选中集合并', () => {
  it('非 additive = 完全替换；additive = 合并去重', () => {
    const prev = new Set(['a', 'b']);
    expect([...mergeSelection(prev, ['c'], false)]).toEqual(['c']);
    expect([...mergeSelection(prev, ['b', 'c', 'c', ''], true)]).toEqual(['a', 'b', 'c']);
    expect([...mergeSelection(prev, [], false)]).toEqual([]);
    expect([...mergeSelection(prev, [], true)]).toEqual(['a', 'b']);
  });

  it('focusAfterBox：取最后一个命中；空框替换清空、空框合并保留原焦点', () => {
    expect(focusAfterBox('old', ['a', 'b'], false)).toBe('b');
    expect(focusAfterBox('old', [], false)).toBeNull();
    expect(focusAfterBox('old', [], true)).toBe('old');
  });
});

describe('useSelection.setSelected（框选写入口）', () => {
  it('默认替换选中集与焦点', () => {
    useSelection.getState().select('a');
    useSelection.getState().setSelected(['b', 'c']);
    const state = useSelection.getState();
    expect([...state.selectedIds]).toEqual(['b', 'c']);
    expect(state.focusId).toBe('c');
  });

  it('Shift 合并保留旧选中，焦点落在新框的最后一个', () => {
    useSelection.getState().setSelected(['a', 'b']);
    useSelection.getState().setSelected(['c'], { additive: true });
    const state = useSelection.getState();
    expect([...state.selectedIds]).toEqual(['a', 'b', 'c']);
    expect(state.focusId).toBe('c');
  });

  it('空框 + 非 additive 清空（点空白/拖空框），空框 + additive 不清空', () => {
    useSelection.getState().setSelected(['a', 'b']);
    useSelection.getState().setSelected([], { additive: true });
    expect(useSelection.getState().selectedIds.size).toBe(2);
    useSelection.getState().setSelected([], { additive: false });
    expect(useSelection.getState().selectedIds.size).toBe(0);
    expect(useSelection.getState().focusId).toBeNull();
  });

  it('Esc 语义 = clear：清空 selectedIds 与 focusId', () => {
    useSelection.getState().setSelected(['a', 'b', 'c']);
    useSelection.getState().clear();
    const state = useSelection.getState();
    expect(state.selectedIds.size).toBe(0);
    expect(state.focusId).toBeNull();
  });

  it('点击单选的既有语义不变（覆盖旧的多选）', () => {
    useSelection.getState().setSelected(['a', 'b']);
    useSelection.getState().select('z');
    const state = useSelection.getState();
    expect([...state.selectedIds]).toEqual(['z']);
    expect(state.focusId).toBe('z');
  });
});
