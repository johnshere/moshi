import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SCOPE,
  assertScope,
  isProjectScope,
  normalizeCwd,
  normalizeScope,
  projectScopeOf,
  scopeCandidates,
} from '../../src/domain/scope.js';

describe('scope：cwd 规范化（V-01）', () => {
  it('Windows 路径：斜杠统一、大小写归一、去尾斜杠', () => {
    expect(normalizeCwd('C:\\Work\\RepoA\\')).toBe('c:/work/repoa');
    expect(normalizeCwd('c:/work/repoa')).toBe('c:/work/repoa');
    expect(normalizeCwd('C:\\')).toBe('c:/');
    expect(normalizeCwd('//Server/Share')).toBe('//server/share');
  });

  it('POSIX 路径保留大小写', () => {
    expect(normalizeCwd('/home/U/Proj/')).toBe('/home/U/Proj');
    expect(normalizeCwd('/')).toBe('/');
  });

  it('幂等：规范化两次与一次相同', () => {
    for (const p of ['C:\\Work\\RepoA\\', '/home/U/Proj/', '//Server/Share']) {
      expect(normalizeCwd(normalizeCwd(p))).toBe(normalizeCwd(p));
    }
  });
});

describe('scope：写入判定', () => {
  it('有 cwd → project:<规范化路径>；无 cwd → global', () => {
    expect(projectScopeOf('C:\\Work\\RepoA')).toBe('project:c:/work/repoa');
    expect(projectScopeOf(null)).toBe(GLOBAL_SCOPE);
    expect(projectScopeOf(undefined)).toBe(GLOBAL_SCOPE);
    expect(projectScopeOf('')).toBe(GLOBAL_SCOPE);
  });

  it('normalizeScope 归一 project 路径，global 原样', () => {
    expect(normalizeScope('project:C:\\Work\\RepoA\\')).toBe('project:c:/work/repoa');
    expect(normalizeScope('global')).toBe(GLOBAL_SCOPE);
    expect(normalizeScope('repo')).toBe('repo');
  });

  it('assertScope 只接受 global 与 project:<非空>', () => {
    expect(() => assertScope('global')).not.toThrow();
    expect(() => assertScope('project:c:/work/a')).not.toThrow();
    expect(() => assertScope('project:')).toThrow(/非法 scope/);
    expect(() => assertScope('session:ss_1')).toThrow(/非法 scope/);
    expect(() => assertScope('repo')).toThrow(/非法 scope/);
  });

  it('isProjectScope 不把 global 认成项目', () => {
    expect(isProjectScope('project:c:/a')).toBe(true);
    expect(isProjectScope('global')).toBe(false);
  });
});

describe('scope：查询候选', () => {
  it('项目查询含 global 兜底，全局查询不含项目', () => {
    expect(scopeCandidates('project:c:/a')).toEqual(['project:c:/a', GLOBAL_SCOPE]);
    expect(scopeCandidates('global')).toEqual(['global']);
  });
});
