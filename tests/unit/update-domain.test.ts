import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isNewer,
  parseVersion,
  pickUpdateAsset,
  updateAssetName,
} from '../../src/domain/update.js';

describe('版本比较（V-03B）', () => {
  it('解析 v 前缀与预发布后缀', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('v0.10.0')).toEqual({ major: 0, minor: 10, patch: 0 });
    expect(parseVersion('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('abc')).toBeNull();
  });

  it('按数值而不是字典序比较', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(isNewer('0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
  });

  it('无法解析的版本视为最小', () => {
    expect(compareVersions('bad', '0.0.1')).toBeLessThan(0);
    expect(compareVersions('0.0.1', 'bad')).toBeGreaterThan(0);
    expect(compareVersions('bad', 'worse')).toBe(0);
  });
});

describe('更新包选择（V-03B）', () => {
  it('只认精确命名的安装包', () => {
    const version = '0.2.0';
    expect(updateAssetName(version)).toBe('moshi-setup-0.2.0.exe');
    expect(
      pickUpdateAsset(
        [
          { name: 'source.zip', url: 'https://github.com/x/y/source.zip' },
          { name: 'moshi-setup-0.2.0.exe', url: 'https://github.com/x/y/moshi-setup-0.2.0.exe', size: 10 },
        ],
        version,
      ),
    ).toEqual({ name: 'moshi-setup-0.2.0.exe', url: 'https://github.com/x/y/moshi-setup-0.2.0.exe', size: 10 });
  });

  it('同名资产缺失时返回 null，不拿别的资产凑数', () => {
    expect(pickUpdateAsset([{ name: 'moshi-setup-0.2.1.exe', url: 'https://github.com/x/y/a.exe' }], '0.2.0')).toBeNull();
    expect(pickUpdateAsset([], '0.2.0')).toBeNull();
  });
});
