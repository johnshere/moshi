/**
 * 布局 worker 入口（P2-01 / 决议 D16）。
 *
 * 这个文件只做一件事：把消息里的纯计算跑掉，把结果回传。**不含任何算法**——
 * 算法在 `domain/layout.ts`，那里不许碰 IO 也不许开线程，测试直接打它。
 *
 * 回传里带 `threadId`：主线程是 0，worker 线程非 0。集成测试拿它当"坐标确实是
 * 在别的线程算出来的"的证据，而不是只看"函数被调过"。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort, threadId } from 'node:worker_threads';
import type { LayoutComputation, LayoutInput, LayoutParams } from '../../domain/layout.js';

// Node 22 的 worker 线程不认 `execArgv: ['--import','tsx']`（execArgv 与
// NODE_OPTIONS 都试过），而原生 type-stripping 又把 `.js` 说明符当成字面文件。
// 源码态在 worker 内显式注册 tsx 的 ESM loader，再按当前扩展名动态导入；
// dist 态 ext 为 `.js`，不触碰 tsx（生产依赖里也没有它）。
const ext = path.extname(fileURLToPath(import.meta.url));
if (ext === '.ts') {
  const { register } = await import('tsx/esm/api');
  register();
}
const { computeLayout } = (await import(
  new URL(`../../domain/layout${ext}`, import.meta.url).href
)) as typeof import('../../domain/layout.js');

export interface LayoutWorkerRequest {
  input: LayoutInput;
  params: LayoutParams;
}

export interface LayoutWorkerReply {
  ok: true;
  result: LayoutComputation;
  threadId: number;
}

export interface LayoutWorkerFailure {
  ok: false;
  error: string;
}

export type LayoutWorkerMessage = LayoutWorkerReply | LayoutWorkerFailure;

const port = parentPort;
if (port !== null) {
  port.on('message', (msg: LayoutWorkerRequest) => {
    try {
      const result: LayoutComputation = computeLayout(msg.input, msg.params);
      port.postMessage({ ok: true, result, threadId } satisfies LayoutWorkerReply);
    } catch (err) {
      // 计算炸了要把原因带回去：worker 里静默抛错只会让主线程等到超时
      port.postMessage({ ok: false, error: (err as Error).message } satisfies LayoutWorkerFailure);
    }
  });
}
