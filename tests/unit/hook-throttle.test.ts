import { describe, expect, it } from 'vitest';
import { createInjectThrottle } from '../../src/app/hook/throttle.js';

describe('注入节流（m04102：记忆注入是低频操作）', () => {
  it('第一次放行；窗口内第二次拒绝；窗口过后再次放行', () => {
    const throttle = createInjectThrottle(() => 10 * 60_000);
    const t0 = 1_000_000;
    expect(throttle.allow('s1', t0)).toBe(true);
    throttle.mark('s1', t0);
    expect(throttle.allow('s1', t0 + 60_000)).toBe(false);
    expect(throttle.allow('s1', t0 + 10 * 60_000)).toBe(true);
    // 会话之间互不影响
    expect(throttle.allow('s2', t0)).toBe(true);
  });

  it('refreshMs=0 表示不节流（每轮都注入）', () => {
    const throttle = createInjectThrottle(() => 0);
    throttle.mark('s1', 1);
    expect(throttle.allow('s1', 1)).toBe(true);
  });

  it('窗口长度现取：设置页把 10 分钟改成 0 后立即生效', () => {
    let refresh = 600_000;
    const throttle = createInjectThrottle(() => refresh);
    throttle.mark('s1', 1_000);
    expect(throttle.allow('s1', 2_000)).toBe(false);
    refresh = 0;
    expect(throttle.allow('s1', 2_000)).toBe(true);
  });
});
