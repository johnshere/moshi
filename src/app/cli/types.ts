/**
 * CLI 命令的形状。
 *
 * 单独一个文件，是为了让 `index.ts`（注册表）与 `commands/*.ts`（实现）
 * 都只依赖它——否则"注册表 import 实现、实现 import 注册表的类型"会形成环，
 * 类型级循环运行时无害，但依赖图会变成一句空话。
 */
import type { Config } from '../config.js';

export interface CommandContext {
  cfg: Config;
  /**
   * 家目录——**与 `cfg` 用同一个来源**，命令里不许自己再猜一遍。
   *
   * 曾经这里没有它，`import` 自己读 `process.env.MOSHI_HOME ?? os.homedir()`，
   * 结果配置从真实 home 加载（`data_dir` 默认 `~/.moshi`）、会话却从另一个 home 扫，
   * 一次冒烟就把测试数据写进了真实 `~/.moshi`。两个 home 必须同源。
   */
  home: string;
  args: readonly string[];
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface Command {
  name: string;
  summary: string;
  run: (ctx: CommandContext) => Promise<number>;
}
