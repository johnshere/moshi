import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    // sidecar 真进程测试用固定命名管道 `\\.\pipe\moshi-infer`（单实例设计），
    // 文件并行会让两个测试文件同时拉起 sidecar 抢管道 → 串行文件执行。
    fileParallelism: false,
    reporters: ['default'],
  },
});
