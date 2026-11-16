/**
 * P3-A4 `tools/seed-devdb.ts` 单测（冻结验收 S7）。
 *
 * 只覆盖两条硬要求 + 两条形状护栏：
 * 1) 同种子同输出：`generateSessions` 是纯函数，两次调用必须逐字节一致；
 * 2) 外来数据拒绝执行：库里已有非本工具的 episode 时 `assertOwnedDb` 抛错且不清空；
 * 3) 生成的 jsonl 行必须能被 `parseClaudeLine` 识别成配对的 tool_use / tool_result；
 * 4) `parseImportSummary` 能从 import 的原文里抠出计数。
 *
 * 全部落在 `mkdtempSync(tmpdir())` 下的临时库，**不碰真实 home**（C:\Users\Administrator）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertIfAbsent } from '../../src/infra/sqlite/episodeRepo.js';
import { parseClaudeLine } from '../../src/core/adapters/claude-code.js';
import {
  ForeignDataError,
  assertOwnedDb,
  DAYS,
  END_MS,
  generateSessions,
  parseImportSummary,
  seedDevDb,
  PROJECT_DIR_NAME,
  SEED,
  SESSIONS_PER_DAY,
  startMsFor,
  writeGoldenFiles,
} from '../../tools/seed-devdb.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-seed-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

/** 本工具写进库里的 episode 只会来自这个目录（P3-A8：不再硬编码某台机器的 home） */
const OWNED_PREFIX = path.join(tmpdir(), 'moshi-seed-owned', PROJECT_DIR_NAME);

describe('generateSessions：同种子同输出', () => {
  it('同种子两次调用逐字节一致', () => {
    const a = generateSessions(SEED);
    const b = generateSessions(SEED);
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('换种子必须变（否则种子没生效）', () => {
    const a = generateSessions(SEED);
    const b = generateSessions(SEED + 1);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('时间跨度 ≥ 14 天，且 tool_use / tool_result 成对、能被适配器配对', () => {
    const sessions = generateSessions(SEED);
    const ts: number[] = [];
    let pairs = 0;
    for (const s of sessions) {
      expect(s.file.endsWith('.jsonl')).toBe(true);
      // 每条会话内部用一份独立 pending 缓冲（与 adapter 实例语义一致）
      const ctx = {
        rawPath: s.file,
        sessionId: 'x',
        fallbackTs: new Date(0).toISOString(),
        agent: 'claude-code',
        pending: new Map(),
      };
      let sawToolEvent = false;
      for (const line of s.lines) {
        const row = JSON.parse(line) as Record<string, unknown>;
        expect(typeof row['timestamp']).toBe('string');
        expect(row['cwd']).toBeTypeOf('string');
        ts.push(Date.parse(String(row['timestamp'])));
        const blocks = (row['message'] as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [];
        for (const block of blocks) {
          if (block['type'] === 'tool_use') sawToolEvent = true;
          if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') pairs += 1;
        }
        // 适配器必须认得每一行（配不上的 tool_result 会被丢弃，故只要求不抛）
        expect(parseClaudeLine(line, ctx)).not.toBeNull();
      }
      expect(sawToolEvent).toBe(true);
    }
    const spanDays = (Math.max(...ts) - Math.min(...ts)) / 86_400_000;
    expect(spanDays).toBeGreaterThanOrEqual(14);
    expect(pairs).toBeGreaterThan(0);
  });
});

describe('--sessions 放大（P3-12 数据面）', () => {
  it('默认会话数起点仍是 START_MS；放大时末端固定、起点等比前移', () => {
    expect(startMsFor(DAYS * SESSIONS_PER_DAY)).toBe(Date.parse('2026-10-20T01:00:00.000Z'));
    expect(startMsFor(24 * SESSIONS_PER_DAY)).toBe(END_MS - 24 * 86_400_000);
  });

  it('按传入数量生成会话，且同种子仍逐字节一致', () => {
    const a = generateSessions(SEED, 10);
    expect(a.length).toBe(10);
    expect(JSON.stringify(a)).toBe(JSON.stringify(generateSessions(SEED, 10)));
  });

  it('放大后时间戳全部早于默认窗口末端（不会把 valid_at 推到未来）', () => {
    for (const s of generateSessions(SEED, 120)) {
      const first = JSON.parse(s.lines[0]!) as { timestamp: string };
      expect(Date.parse(first.timestamp)).toBeLessThan(END_MS);
    }
  });
});

describe('assertOwnedDb：外来数据拒绝执行', () => {
  it('空库放行', () => {
    const db = freshDb();
    const res = assertOwnedDb(db, OWNED_PREFIX);
    expect(res.empty).toBe(true);
    expect(Object.values(res.rows).every((n) => n === 0)).toBe(true);
  });

  it('本工具自己的 episode 放行（幂等重跑）', () => {
    const db = freshDb();
    insertIfAbsent(db, {
      ts: '2026-10-21T01:00:00.000Z',
      rawHash: 'hash-owned',
      session: 'p3a4-00-0',
      rawPath: path.join(OWNED_PREFIX, 'p3a4-00-0.jsonl'),
    });
    expect(assertOwnedDb(db, OWNED_PREFIX).empty).toBe(false);
  });

  it('库里已有别人的数据 → 抛 ForeignDataError，且一行都不删', () => {
    const db = freshDb();
    const foreignPath = path.join(
      tmpdir(),
      'moshi-seed-foreign-home',
      '.claude',
      'projects',
      'some-real-project',
      'session.jsonl',
    );
    insertIfAbsent(db, { ts: '2026-10-21T01:00:00.000Z', rawHash: 'hash-foreign', rawPath: foreignPath });
    let caught: unknown = null;
    try {
      assertOwnedDb(db, OWNED_PREFIX);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForeignDataError);
    expect((caught as ForeignDataError).foreign.length).toBe(1);
    const left = db.prepare('SELECT COUNT(*) AS n FROM episode').get() as { n: number };
    expect(left.n).toBe(1);
    expect((db.prepare('SELECT raw_path AS p FROM episode').get() as { p: string }).p).toBe(foreignPath);
  });
});

describe('parseImportSummary', () => {
  it('从 import 原文抠出计数', () => {
    const text =
      '导入完成：75 个会话、1396 个回合、212 条新事实（刷新 1007）、0 条进隔离区、4 条未识别、0 条失败、' +
      '谓词基数性更新 2 条，用时 6.7s\n当前库：fact=405 edge=1682 entity=178 episode=1396 annotation=698';
    expect(parseImportSummary(text)).toEqual({
      sessions: 75,
      turns: 1396,
      facts: 212,
      refreshed: 1007,
      quarantined: 0,
      skipped: 4,
      failed: 0,
      promoted: 2,
    });
  });

  it('缺字段时全 0（不抛）', () => {
    expect(parseImportSummary('nothing here').sessions).toBe(0);
  });
});

describe('writeGoldenFiles（S1：默认路径兜底）', () => {
  it('v1 与默认名 golden.jsonl 都写，内容逐字节一致', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'moshi-golden-'));
    try {
      const body = '{"id":"g-1"}\n{"id":"g-2"}\n';
      const res = writeGoldenFiles(path.join(dir, 'golden'), body);
      expect(res.v1).toBe(path.join(dir, 'golden', 'golden.v1.jsonl'));
      expect(res.defaultFile).toBe(path.join(dir, 'golden', 'golden.jsonl'));
      expect(readFileSync(res.v1, 'utf8')).toBe(body);
      expect(readFileSync(res.defaultFile, 'utf8')).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seedDevDb --config（P3-A8 统一配置）', () => {
  it('dry-run：会话根/库/golden 都跟着配置走，临时 home 下不创建 ~/.moshi', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'moshi-seed-cfg-'));
    const home = path.join(tmp, 'home'); // 故意不创建
    const dataDir = path.join(tmp, 'data');
    const projectsRoot = path.join(tmp, 'projects');
    const configFile = path.join(tmp, 'config.yaml');
    writeFileSync(
      configFile,
      [
        'storage:',
        `  data_dir: "${dataDir.replace(/\\/g, '/')}"`,
        '',
        'collect:',
        '  sources:',
        '    - id: "dev"',
        '      adapter: "claude-code"',
        `      root: "${projectsRoot.replace(/\\/g, '/')}"`,
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      const res = await seedDevDb({ configFile, dryRun: true, home });
      // 会话根 = 配置里 source 的 root
      expect(res.projectDir).toBe(path.join(projectsRoot, PROJECT_DIR_NAME));
      expect(existsSync(res.projectDir)).toBe(true);
      // golden 跟 data_dir 走，不再写真实 home
      expect(res.goldenFile).toBe(path.join(dataDir, 'golden', 'golden.v1.jsonl'));
      // 关键：配置没指向真实 home，就不该在临时 home 下留任何库文件
      expect(existsSync(path.join(home, '.moshi'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
