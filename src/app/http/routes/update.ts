/**
 * 自动更新接口（V-03B）。
 *
 * - `GET  /api/update`          查 GitHub Releases latest（60s 内存缓存，`?force=1` 跳过）
 * - `POST /api/update/download` 把安装包落到 `<data_dir>/updates/`
 * - `POST /api/update/install`  静默安装并重启；先回包再停当前 daemon
 *
 * 下载与安装的 IO 都可注入，单测不联网、不真的起安装器。
 */
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import type { Config } from '../../config.js';
import { VERSION } from '../../version.js';
import { checkForUpdate, emptyStatus, type UpdateStatus } from '../../update/check.js';
import { downloadInstaller, installerPath } from '../../update/download.js';
import { spawnInstaller } from '../../update/install.js';

const CACHE_MS = 60_000;

export interface UpdateRoutesDeps {
  cfg: Config;
  currentVersion?: string;
  /** daemon 停止回调；不传（CLI/测试）时 install 只回包不退出 */
  onStop?: () => void;
  fetchImpl?: typeof fetch;
  /** 测试注入：替代真实 spawn */
  runInstaller?: (installer: string) => void;
  now?: () => Date;
}

export async function updateRoutes(app: FastifyInstance, deps: UpdateRoutesDeps): Promise<void> {
  const current = deps.currentVersion ?? VERSION;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  let cached: UpdateStatus | null = null;
  let cachedAt = 0;

  const check = async (force: boolean): Promise<UpdateStatus> => {
    if (!deps.cfg.update.enabled) {
      return {
        ...emptyStatus(current, now().toISOString(), null),
        enabled: false,
        ok: true,
      };
    }
    if (!force && cached !== null && now().getTime() - cachedAt < CACHE_MS) return cached;
    const status = await checkForUpdate(deps.cfg, current, fetchImpl, now);
    cached = status;
    cachedAt = now().getTime();
    return status;
  };

  app.get('/api/update', async (req, reply) => {
    const force = (req.query as { force?: string }).force === '1';
    return reply.send(await check(force));
  });

  app.post('/api/update/download', async (_req, reply) => {
    const status = await check(true);
    if (!status.available) {
      return reply.code(409).send({ error: 'E_UPDATE', message: '当前没有可下载的新版本' });
    }
    try {
      const file = await downloadInstaller(deps.cfg, status, fetchImpl);
      return reply.send({
        ok: true,
        version: status.latest,
        path: file.path,
        bytes: file.bytes,
      });
    } catch (err) {
      return reply
        .code(502)
        .send({ error: 'E_UPDATE', message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/update/install', async (_req, reply) => {
    const status = await check(true);
    if (!status.available || status.latest === null) {
      return reply.code(409).send({ error: 'E_UPDATE', message: '当前没有可安装的新版本' });
    }
    const file = installerPath(deps.cfg, status.latest);
    if (!existsSync(file)) {
      return reply.code(409).send({ error: 'E_UPDATE', message: '请先下载更新包' });
    }
    try {
      if (deps.runInstaller !== undefined) deps.runInstaller(file);
      else spawnInstaller(file);
    } catch (err) {
      return reply
        .code(500)
        .send({ error: 'E_UPDATE', message: err instanceof Error ? err.message : String(err) });
    }
    reply.send({ ok: true, version: status.latest });
    if (deps.onStop !== undefined) setImmediate(deps.onStop);
    return reply;
  });
}
