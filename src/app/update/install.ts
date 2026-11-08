/**
 * 更新包安装（V-03B）：静默跑安装器，装完重新拉起并打开界面。
 *
 * 安装脚本自己不退出 daemon——本函数被路由调用后，路由会触发 `onStop` 让当前
 * daemon 释放文件；安装器的第一段又会跑 `stop-moshi.ps1` 兜底，所以两条路径都
 * 不会出现"边写边锁"。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MoshiError } from '../../domain/errors.js';

/** 安装根目录：dist/app/update → 项目/安装根 */
export function appRoot(): string {
  return path.resolve(import.meta.dirname, '../../..');
}

/** 安装器旁边的 `launch.vbs`；开发目录里没有就不自动重开（避免误起安装器） */
export function launchScript(): string | null {
  const file = path.join(appRoot(), 'launch.vbs');
  return existsSync(file) ? file : null;
}

export function spawnInstaller(installer: string): void {
  if (process.platform !== 'win32') {
    throw new MoshiError('E_UPDATE', '自动安装目前只支持 Windows');
  }
  if (!existsSync(installer)) {
    throw new MoshiError('E_UPDATE', '更新包不存在，请先下载', { installer });
  }
  const sysRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  const wscript = path.join(sysRoot, 'System32', 'wscript.exe');
  const vbs = launchScript();
  const restart = vbs === null ? '' : ` && start "" "${wscript}" //nologo "${vbs}" init`;
  const command = `"${installer}" /S${restart}`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
