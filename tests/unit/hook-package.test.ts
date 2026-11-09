/**
 * 钩子入口包的**一致性**测试（Z-01C）。
 *
 * `packages/magpie-moshi/identity.cjs` 是 `domain/identity.ts` 的一份零依赖可复制实现
 * ——因为 Magpie 的 plugin-host 在自己的进程里加载它，拿不到 moshi 的 dist。
 * 两份实现的口径一旦漂移，同一个会话在钩子里算出的 `moshi_id` 与 daemon 落库的
 * 就不一样，跨入口归并会静默失效。所以这里**逐向量对照真实输出**，不靠人眼核对。
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { projectIdOf, sessionMoshiId } from '../../src/domain/identity.js';

const require = createRequire(import.meta.url);
const pkg = require('../../packages/magpie-moshi/identity.cjs') as {
  sessionMoshiId: (id: string) => string | null;
  projectIdOf: (input: { kind: 'vcs'; root: string; remote: string | null } | { kind: 'local'; root: string }) => string | null;
};

describe('packages/magpie-moshi/identity.cjs 与 domain/identity.ts 逐字节一致', () => {
  it('会话 id', () => {
    const ids = ['sess-1', '  spaced  ', '会话-中文', 'a:b/c\\d', '0000'];
    for (const id of ids) {
      expect(pkg.sessionMoshiId(id)).toBe(sessionMoshiId({ id }));
    }
  });

  it('会话 id 为空时两边都返回 null', () => {
    expect(pkg.sessionMoshiId('')).toBeNull();
    expect(pkg.sessionMoshiId('   ')).toBeNull();
    expect(sessionMoshiId({ id: '' })).toBeNull();
  });

  it('vcs 工程（有/无 remote）', () => {
    const roots = ['j:/workspace/codes/moshi', 'C:\\Users\\john\\proj', '/home/x/p'];
    for (const root of roots) {
      for (const remote of ['github.com/johnshere/moshi', null] as const) {
        const input = { kind: 'vcs' as const, root, remote };
        expect(pkg.projectIdOf(input)).toBe(projectIdOf(input));
      }
    }
  });

  it('local 工程', () => {
    for (const root of ['j:/temp/x', '/tmp/y', 'd:/中文/目录']) {
      const input = { kind: 'local' as const, root };
      expect(pkg.projectIdOf(input)).toBe(projectIdOf(input));
    }
  });

  it('空 root 两边都返回 null', () => {
    expect(pkg.projectIdOf({ kind: 'local', root: '' })).toBeNull();
    expect(projectIdOf({ kind: 'local', root: '' })).toBeNull();
  });

  it('固定向量（升级哈希口径时这一条必须一起改，否则等于静默破坏兼容）', () => {
    // 这组值是在实现时用 daemon 侧真实函数算出来的
    expect(pkg.sessionMoshiId('sess-1')).toBe('b56ed156bab52740c805785237405f43');
    expect(projectIdOf({ kind: 'vcs', root: 'j:/workspace/codes/moshi', remote: 'github.com/johnshere/moshi' }))
      .toBe(pkg.projectIdOf({ kind: 'vcs', root: 'j:/workspace/codes/moshi', remote: 'github.com/johnshere/moshi' }));
  });
});
