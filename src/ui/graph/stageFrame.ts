/**
 * 舞台取景器（纯装饰）：四角准星 + 顶部刻度尺，压在画布上，不吃事件。
 *
 * 为什么不用 CSS 固定 inset：HUD 是画布上的绝对定位浮层，高度随提示行（截断/无布局/错误）
 * 变化。取景器的顶边必须跟着 HUD 的底边走，否则顶边永远藏在面板后面——只有左右两条竖线
 * 能看见，读起来像渲染残留。这里量一次 HUD 底边、再用 ResizeObserver 跟住它。
 *
 * 2D / 3D 各自 mount（切视图时画布整体重建），视觉上是同一个外框。
 */
const FRAME_CLASS = 'graph-stage-frame';
const EDGE_INSET = 8;

export function mountStageFrame(host: HTMLElement): () => void {
  const frame = document.createElement('div');
  frame.className = FRAME_CLASS;
  frame.setAttribute('aria-hidden', 'true');
  host.appendChild(frame);

  const sync = (): void => {
    const hud = document.querySelector<HTMLElement>('.moshi-hud');
    if (hud === null) {
      frame.style.top = `${EDGE_INSET}px`;
      host.style.setProperty('--stage-safe-top', `${EDGE_INSET}px`);
      return;
    }
    const top = hud.getBoundingClientRect().bottom - host.getBoundingClientRect().top + EDGE_INSET;
    const px = `${Math.round(Math.max(top, EDGE_INSET))}px`;
    frame.style.top = px;
    // 画布层的安全边距：标签（3D 的 DOM 标签层 / 2D 的整块画布）按这条线裁掉 HUD 下的部分，
    // 否则亮色主题下白字会压到浅色 HUD 上（验收 S2）。用 CSS 变量传给 `app.css` 的遮罩。
    host.style.setProperty('--stage-safe-top', px);
  };

  // HUD 在本组件之后挂载（同一个 React 提交里），首帧量不到，等一帧再挂观察者
  let observer: ResizeObserver | null = null;
  const raf = requestAnimationFrame(() => {
    sync();
    const hud = document.querySelector<HTMLElement>('.moshi-hud');
    if (hud === null) return;
    observer = new ResizeObserver(sync);
    observer.observe(hud);
    observer.observe(host);
  });

  return () => {
    cancelAnimationFrame(raf);
    observer?.disconnect();
    frame.remove();
  };
}
