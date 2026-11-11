/**
 * 工程身份识别（Z-01C / 设计 §5、决策 D-175）。
 *
 * 三步走：版本控制标志 → 就近自建 `.moshi/project.yaml` → 自建。
 * 这里逐条钉住每一步的**判定与可信度档位**，因为它是"记忆挂到哪个工程下"的唯一凭据：
 * 判错一次，之后所有事实都挂在错的工程里，且 id 生成后永不改变。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MARKER_DIR,
  MARKER_FILE,
  normalizeRemote,
  readMarkerProjectId,
  resolveProjectIdentity,
} from '../../src/app/hook/projectIdentity.js';

const dirs: string[] = [];

/** 从 dir 向上找版本控制标志（识别规则本身就这么走，测试目录必须落在链外） */
function insideVcs(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    for (const marker of ['.git', '.svn', '.hg']) {
      if (existsSync(path.join(cur, marker))) return true;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * 选一个**不在任何版本库工作树里**的临时根。
 *
 * 为什么不是直接用 `os.tmpdir()`：本机（以及 `TEMP` 重定向到工程内时的 CI）
 * 临时目录可能正好落在某个 git 仓库里，那样"没有版本控制标志"这一档就测不出来。
 */
function tempRoot(): string {
  const localAppData = process.env['LOCALAPPDATA'];
  const candidates = [
    tmpdir(),
    localAppData === undefined ? null : path.join(localAppData, 'Temp'),
    path.join(homedir(), 'AppData', 'Local', 'Temp'),
    homedir(),
  ];
  for (const candidate of candidates) {
    if (candidate !== null && !insideVcs(candidate)) return candidate;
  }
  return tmpdir();
}

function tempDir(): string {
  const d = mkdtempSync(path.join(tempRoot(), 'moshi-ident-'));
  dirs.push(d);
  return d;
}

/** 造一个"看着像 git 仓库"的目录（只放 `.git/`，不起 git 子进程） */
function fakeRepo(dir: string, remote?: string): string {
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (remote !== undefined) {
    writeFileSync(
      path.join(dir, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    );
  }
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 偶发 EBUSY，不影响断言 */
    }
  }
});

describe('normalizeRemote', () => {
  it('scp 与 https 两种写法归成同一个串', () => {
    expect(normalizeRemote('git@github.com:John/Moshi.git')).toBe(normalizeRemote('https://github.com/john/moshi.git'));
  });

  it('本地路径 remote 原样保留（同一目录仍然稳定）', () => {
    expect(normalizeRemote('J:\\Repo\\Demo\\')).toBe('j:/repo/demo');
  });

  it('空串 → null', () => {
    expect(normalizeRemote('   ')).toBeNull();
  });
});

describe('resolveProjectIdentity：三步识别', () => {
  it('有 .git 就用仓库根（子目录也给同一个 id）', () => {
    const root = fakeRepo(tempDir(), 'git@github.com:john/moshi.git');
    const sub = path.join(root, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    const a = resolveProjectIdentity(root);
    const b = resolveProjectIdentity(sub);
    expect(a.source).toBe('vcs');
    expect(a.root).toBe(root.replace(/\\/g, '/'));
    expect(b.projectId).toBe(a.projectId);
    expect(a.remote).toBe('github.com/john/moshi');
  });

  it('没有 remote 的仓库：id 由仓库根决定，不是由 cwd 决定', () => {
    const root = fakeRepo(tempDir());
    const sub = path.join(root, 'pkg');
    mkdirSync(sub, { recursive: true });
    const a = resolveProjectIdentity(root);
    expect(a.source).toBe('vcs');
    expect(a.remote).toBeNull();
    expect(resolveProjectIdentity(sub).projectId).toBe(a.projectId);
  });

  it('两个不同 remote 的同名目录拿到不同 id（跨机器认的是 remote）', () => {
    const x = fakeRepo(tempDir(), 'git@github.com:john/moshi.git');
    const y = fakeRepo(tempDir(), 'git@github.com:other/moshi.git');
    expect(resolveProjectIdentity(x).projectId).not.toBe(resolveProjectIdentity(y).projectId);
  });

  it('没有版本控制标志、create=false：如实 unknown，绝不顺手建标志', () => {
    const dir = tempDir();
    const r = resolveProjectIdentity(dir);
    expect(r.source).toBe('unknown');
    expect(r.projectId).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('就近自带标志优先于更上层的标志（子工程不会被父工程吞掉）', () => {
    const parent = tempDir();
    mkdirSync(path.join(parent, MARKER_DIR), { recursive: true });
    writeFileSync(path.join(parent, MARKER_DIR, MARKER_FILE), 'schema: moshi-project/1\n');
    const child = path.join(parent, 'child');
    mkdirSync(path.join(child, MARKER_DIR), { recursive: true });
    writeFileSync(path.join(child, MARKER_DIR, MARKER_FILE), 'schema: moshi-project/1\n');
    expect(resolveProjectIdentity(child).root).toBe(child.replace(/\\/g, '/'));
  });

  it('只有上层有标志：子目录沿用上层（不重复自建）', () => {
    const parent = tempDir();
    const r = resolveProjectIdentity(parent, { create: 'establish', roots: [parent] });
    const child = path.join(parent, 'child');
    mkdirSync(child, { recursive: true });
    expect(resolveProjectIdentity(child).projectId).toBe(r.projectId);
    expect(readdirSync(child)).toEqual([]);
  });

  it('自建档：create=establish 且给了白名单 → 落 .moshi/project.yaml，id 落盘后不变', () => {
    const base = tempDir();
    const dir = path.join(base, 'proj');
    mkdirSync(dir, { recursive: true });
    const r = resolveProjectIdentity(dir, { create: 'establish', roots: [base] });
    expect(r.source).toBe('local');
    const written = readMarkerProjectId(dir);
    expect(written).toBe(r.projectId);
    // 第二次（哪怕白名单不给）还是同一个 id：落盘之后就是权威
    expect(resolveProjectIdentity(dir).projectId).toBe(r.projectId);
  });

  it('自建档：没给白名单就不落盘，但如实说"未落盘"而不是假装成功', () => {
    const dir = tempDir();
    const r = resolveProjectIdentity(dir, { create: 'establish' });
    expect(r.source).toBe('local');
    expect(r.reason).toContain('未落盘');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('名字就叫 .moshi 的目录本身不算工程根（否则会把自己的标志目录当工程）', () => {
    const base = tempDir();
    const markerDir = path.join(base, MARKER_DIR);
    mkdirSync(markerDir, { recursive: true });
    const r = resolveProjectIdentity(markerDir, { create: 'establish', roots: [base] });
    // 向上跳过 .moshi 自身，落到 base 自建
    expect(r.root).toBe(base.replace(/\\/g, '/'));
  });

  it('cwd 不存在 / 为空 → unknown（不拿 daemon 的 cwd 充数）', () => {
    expect(resolveProjectIdentity(path.join(tempDir(), 'nope')).source).toBe('unknown');
    expect(resolveProjectIdentity('').source).toBe('unknown');
    expect(resolveProjectIdentity(null).source).toBe('unknown');
    expect(resolveProjectIdentity(undefined).source).toBe('unknown');
  });
});
