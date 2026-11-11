/**
 * 入驻三件套的单测（Z-01C-h/i / 设计 §16.3、§16.6）：
 *   状态文件（容错）、三路探测（全注入，不碰真网络/真进程）、Magpie 安装器（真写临时目录）。
 *
 * 安装器这组是**真写盘**：目标根放在临时目录里，白名单也指向它——这正好验证了
 * "例外通道只放行用户确认的那一个目录"这条约束没有偷偷放宽。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ONBOARD_SCHEMA,
  emptyOnboarding,
  parseOnboarding,
  patchOnboarding,
  readOnboarding,
  writeOnboarding,
  type OnboardState,
} from '../../src/app/onboard/state.js';
import { DETECT_TARGETS, MAGPIE_PORT, detectHosts, describeTarget } from '../../src/app/onboard/detect.js';
import {
  PLUGIN_DIR_ENV,
  applyMagpieHook,
  installKey,
  planMagpieHook,
  planMcp,
  pluginRootCandidates,
  uninstallMagpieHook,
} from '../../src/app/onboard/install.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-onboard-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略：Windows 上偶发 EBUSY */
    }
  }
});

describe('onboarding.json 状态文件', () => {
  it('写进去再读回来，探测结果与安装记录都不丢', () => {
    const dataDir = tempDir();
    const state: OnboardState = {
      ...emptyOnboarding(),
      first_open_at: '2026-11-10T00:00:00.000Z',
      dialog_shown: true,
      detected: {
        at: '2026-11-10T00:01:00.000Z',
        hosts: {
          magpie: { hit: true, via: ['dir', 'port'], dir: '/home/u/.config/magpie', port: MAGPIE_PORT, process: null },
          'claude-code': { hit: false, via: [], dir: null, port: null, process: null },
          dsh: { hit: false, via: [], dir: null, port: null, process: null },
        },
      },
      installs: {
        [installKey('magpie', 'hook')]: {
          state: 'installed',
          at: '2026-11-10T00:02:00.000Z',
          path: '/home/u/.config/magpie/plugins',
          version: '0.2.0',
          reason: null,
          files: ['/a'],
          backup: '{"plugins":[]}',
        },
      },
    };
    writeOnboarding(dataDir, state);
    const back = readOnboarding(dataDir);
    expect(back.schema).toBe(ONBOARD_SCHEMA);
    expect(back.first_open_at).toBe(state.first_open_at);
    expect(back.detected?.hosts.magpie.via).toEqual(['dir', 'port']);
    expect(back.installs['magpie-hook']?.state).toBe('installed');
  });

  it('文件坏掉/字段类型不对 → 退回空状态，不抛（装错了要能打开设置页修）', () => {
    const dataDir = tempDir();
    writeFileSync(path.join(dataDir, 'onboarding.json'), '{ 不是 json');
    expect(readOnboarding(dataDir).dialog_shown).toBe(false);

    const parsed = parseOnboarding({ schema: 1, detected: { at: 1, hosts: 'x' }, installs: { a: 3 } });
    expect(parsed).toEqual(emptyOnboarding());
  });

  it('patchOnboarding 只做浅合并，其余字段保持原值', () => {
    const dataDir = tempDir();
    patchOnboarding(dataDir, { first_open_at: 't1' });
    const after = patchOnboarding(dataDir, { dialog_shown: true });
    expect(after.first_open_at).toBe('t1');
    expect(after.dialog_shown).toBe(true);
  });
});

describe('三路探测', () => {
  const noExist = (): boolean => false;

  it('三路都没命中 → hit=false，via 为空（不猜）', async () => {
    const detected = await detectHosts({
      home: tempDir(),
      env: {},
      exists: noExist,
      portOpen: async () => false,
      processNames: async () => [],
    });
    for (const host of Object.values(detected.hosts)) {
      expect(host.hit).toBe(false);
      expect(host.via).toEqual([]);
    }
  });

  it('Magpie 三路全中：via 按 dir/port/process 顺序记证据', async () => {
    const home = tempDir();
    const dir = path.join(home, '.config', 'magpie');
    const detected = await detectHosts({
      home,
      env: {},
      exists: (file) => file === dir,
      portOpen: async (_host, port) => port === MAGPIE_PORT,
      processNames: async () => ['explorer.exe', 'magpie-windows-amd64.exe'],
    });
    const magpie = detected.hosts.magpie;
    expect(magpie.hit).toBe(true);
    expect(magpie.via).toEqual(['dir', 'port', 'process']);
    expect(magpie.dir).toBe(dir);
    expect(magpie.port).toBe(MAGPIE_PORT);
    expect(magpie.process).toBe('magpie-windows-amd64.exe');
  });

  it('任一路抛错只影响自己：端口探测抛错，目录命中仍算检测到', async () => {
    const home = tempDir();
    const ccDir = path.join(home, '.claude');
    const detected = await detectHosts({
      home,
      env: {},
      exists: (file) => file === ccDir,
      portOpen: async () => {
        throw new Error('boom');
      },
      processNames: async () => [],
    });
    expect(detected.hosts['claude-code'].hit).toBe(true);
    expect(detected.hosts['claude-code'].via).toEqual(['dir']);
    expect(detected.hosts.magpie.via).toEqual([]);
  });

  it('进程名必须精确匹配：`magpie-helper` 不算 Magpie 在跑', async () => {
    const detected = await detectHosts({
      home: tempDir(),
      env: {},
      exists: noExist,
      portOpen: async () => false,
      processNames: async () => ['magpie-helper-x'],
    });
    expect(detected.hosts.magpie.hit).toBe(false);
  });

  it('线索表与说明文案同源（诊断里能看到去哪儿找）', () => {
    const magpie = DETECT_TARGETS.find((t) => t.host === 'magpie');
    expect(magpie).toBeDefined();
    const text = describeTarget(magpie!, '/home/u', {});
    expect(text).toContain('3425');
    expect(text).toContain('.config/magpie');
  });
});

describe('Magpie 插件安装器', () => {
  /** 造一份"moshi 安装包"：4 个运行时文件 + 带版本的 package.json */
  function fakeSource(): string {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'hook.cjs'), 'module.exports = {};\n');
    writeFileSync(path.join(dir, 'identity.cjs'), 'module.exports = {};\n');
    writeFileSync(path.join(dir, 'index.cjs'), "require('./hook.cjs');\n");
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'magpie-moshi', version: '0.2.0' }));
    return dir;
  }

  function setup(existingSpecs: readonly string[] = []): {
    configDir: string;
    root: string;
    dataDir: string;
    sourceDir: string;
    env: NodeJS.ProcessEnv;
  } {
    const configDir = tempDir();
    const root = path.join(configDir, 'plugins');
    mkdirSync(root, { recursive: true });
    // 注册表在配置根、不在 plugins/ 里（设计 §16.11 E2：写错位置会静默失效）
    if (existingSpecs.length > 0) {
      writeFileSync(
        path.join(configDir, 'plugins.json'),
        JSON.stringify({ plugins: existingSpecs.map((spec) => ({ spec })) }),
      );
    }
    return { configDir, root, dataDir: tempDir(), sourceDir: fakeSource(), env: { [PLUGIN_DIR_ENV]: root } };
  }

  it('没有 Magpie 插件目录 → 计划 unsupported，不猜路径', () => {
    const home = tempDir();
    const plan = planMagpieHook({ dataDir: tempDir(), home, env: {}, sourceDir: fakeSource() });
    expect(plan.supported).toBe(false);
    expect(plan.reason).toContain('没找到 Magpie 插件目录');
    expect(plan.steps).toEqual([]);
  });

  it('环境变量覆盖优先于默认候选（测试与非常规安装位置的唯一入口）', () => {
    const { root, env } = setup();
    expect(pluginRootCandidates('/home/u', env)).toEqual([path.resolve(root)]);
    expect(pluginRootCandidates('/home/u', {})).toContain(path.join('/home/u', '.config', 'magpie', 'plugins'));
  });

  it('计划 = 4 个包文件 + 注册表，且每条都带动作', () => {
    const { configDir, root, dataDir, sourceDir, env } = setup(['@magpie-community/other@latest']);
    const plan = planMagpieHook({ dataDir, env, sourceDir });
    expect(plan.supported).toBe(true);
    expect(plan.root).toBe(path.resolve(root));
    expect(plan.version).toBe('0.2.0');
    expect(plan.steps.map((step) => path.basename(step.path))).toEqual([
      'hook.cjs',
      'identity.cjs',
      'index.cjs',
      'package.json',
      'plugins.json',
    ]);
    // 注册表必须在配置根，不在 plugins/ 里（K7）
    expect(plan.steps[plan.steps.length - 1]?.path).toBe(path.join(configDir, 'plugins.json'));
    expect(plan.steps[plan.steps.length - 1]?.note).toContain('以路径 spec 注册');
    expect(plan.steps.map((step) => step.action)).toEqual(['新增', '新增', '新增', '新增', '修改']);
    expect(plan.risk).toContain('尚未端到端验证');
  });

  it('没点确认就一个字节都不写（确认弹窗不是装饰）', () => {
    const { configDir, root, dataDir, sourceDir, env } = setup();
    const outcome = applyMagpieHook({ dataDir, env, sourceDir, confirm: false });
    expect(outcome.written).toEqual([]);
    expect(existsSync(path.join(root, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(configDir, 'plugins.json'))).toBe(false);
  });

  it('确认后真写：包文件到位、注册表追加 path spec、记录可回推', () => {
    const { configDir, root, dataDir, sourceDir, env } = setup(['@magpie-community/other@latest']);
    const outcome = applyMagpieHook({ dataDir, env, sourceDir, confirm: true });
    expect(outcome.record.state).toBe('installed');
    expect(outcome.written.length).toBe(5);
    const installed = path.join(root, 'node_modules', 'magpie-moshi');
    expect(existsSync(path.join(installed, 'hook.cjs'))).toBe(true);
    const spec = JSON.parse(readFileSync(path.join(configDir, 'plugins.json'), 'utf8')) as { plugins: { spec: string }[] };
    // 注册表写的是包目录的绝对路径（与 `magpie plugin add <本地路径>` 一致）
    expect(spec.plugins.map((p) => p.spec)).toContain(path.resolve(installed));
    // 原有插件不能被顶掉
    expect(spec.plugins.map((p) => p.spec)).toContain('@magpie-community/other@latest');
    expect(readOnboarding(dataDir).installs['magpie-hook']?.state).toBe('installed');
  });

  it('重复安装幂等：注册表里不出现两条本包 spec', () => {
    const { configDir, root, dataDir, sourceDir, env } = setup();
    applyMagpieHook({ dataDir, env, sourceDir, confirm: true });
    applyMagpieHook({ dataDir, env, sourceDir, confirm: true });
    const spec = JSON.parse(readFileSync(path.join(configDir, 'plugins.json'), 'utf8')) as { plugins: { spec: string }[] };
    expect(spec.plugins.filter((p) => p.spec === path.resolve(path.join(root, 'node_modules', 'magpie-moshi'))).length).toBe(1);
  });

  it('卸载：删包文件、清掉我们的 spec、把状态标回 absent', () => {
    const { configDir, root, dataDir, sourceDir, env } = setup(['@magpie-community/other@latest']);
    applyMagpieHook({ dataDir, env, sourceDir, confirm: true });
    const outcome = uninstallMagpieHook({ dataDir, env, sourceDir });
    expect(outcome.record.state).toBe('absent');
    expect(existsSync(path.join(root, 'node_modules', 'magpie-moshi', 'hook.cjs'))).toBe(false);
    const spec = JSON.parse(readFileSync(path.join(configDir, 'plugins.json'), 'utf8')) as { plugins: { spec: string }[] };
    expect(spec.plugins.map((p) => p.spec)).toEqual(['@magpie-community/other@latest']);
  });

  it('没有安装记录时卸载什么都不做（不误删别人的东西）', () => {
    const { root, dataDir, sourceDir, env } = setup(['@magpie-community/other@latest']);
    mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const outcome = uninstallMagpieHook({ dataDir, env, sourceDir });
    expect(outcome.written).toEqual([]);
    expect(outcome.record.state).toBe('absent');
  });

  it('MCP 类恒 unsupported（本轮只显示，设计 §16.7）', () => {
    for (const host of ['magpie', 'claude-code', 'dsh'] as const) {
      const plan = planMcp(host);
      expect(plan.supported).toBe(false);
      expect(plan.reason).toContain('本轮未实现');
    }
  });
});
