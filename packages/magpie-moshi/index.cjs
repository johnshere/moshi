/**
 * Magpie 插件包（Z-01C）。
 *
 * `magpie.hooks` 是 Magpie plugin-host 认的入口：它要求这个文件导出
 * `onRequest(body, ctx)` / `onResponse(reply, ctx)`，并在请求前/响应后各调一次。
 *
 * 本文件**没有运行时依赖**（只有 node:crypto），因为它跑在 Magpie 的进程里，
 * 不是跑在 moshi 的进程里——详见 `hook.cjs` 的注释。
 */
'use strict';

module.exports = require('./hook.cjs');
