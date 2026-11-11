/**
 * 注入节流的会话状态（m04102：给 Agent 间对话注入记忆是**低频**操作）。
 *
 * 每次经 Magpie 网关的 LLM 请求都会触发钩子，一个用户回合里往往有十几步
 * 工具循环；每步都注入等于每步都破坏一次前缀、每步都多几百字节。
 *
 * 这里只在内存里记「这个会话上次真正注入了什么时间」，窗口内直接返回
 * `inject:false` + `degraded:['throttled']`。daemon 重启后状态清空，第一轮
 * 会重新注入——这是有意的：宁可多注一次，也不要让新进程一直"以为注过了"。
 */
export interface InjectThrottle {
  /** 这个会话现在能不能注入 */
  allow(key: string, at: number): boolean;
  /** 记下"这一轮真的注入了"，窗口从此刻重新计时 */
  mark(key: string, at: number): void;
}

/** 内存里最多记多少个会话（超过就丢最旧的） */
const MAX_ENTRIES = 512;

/**
 * @param refreshMs 窗口长度，每次调用时现取（设置页改配置后立即生效）；`<= 0` 表示不节流
 */
export function createInjectThrottle(refreshMs: () => number): InjectThrottle {
  const last = new Map<string, number>();
  return {
    allow(key, at) {
      const refresh = refreshMs();
      if (refresh <= 0) return true;
      const previous = last.get(key);
      return previous === undefined || at - previous >= refresh;
    },
    mark(key, at) {
      if (refreshMs() <= 0) return;
      last.delete(key);
      last.set(key, at);
      while (last.size > MAX_ENTRIES) {
        const oldest = last.keys().next();
        if (oldest.done === true) break;
        last.delete(oldest.value);
      }
    },
  };
}
