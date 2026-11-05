/** setup-lib.mjs 的类型声明（tests 通过 vitest/tsc import 需要；实现见 setup-lib.mjs） */
export declare const PYPI_INDEX_DEFAULT: string;
export declare const ENCODE_MODULES_WIN: readonly string[];
export declare const ENCODE_MODULES_UNIX: readonly string[];
export declare const MODEL_REL: string;
export declare const DEPS_HASH_FILE: string;
export declare const LOCK_FILE: string;
export declare const REQ_FILE: string;

export interface ParsedArgs {
  force: boolean;
  hook: boolean;
  check: boolean;
  help: boolean;
  unknown?: string;
}

export declare function parseArgs(argv: readonly string[]): ParsedArgs;

export declare function venvPythonPath(venvDir: string, platform: string): string;
export declare function sysPythonCommand(platform: string): [string, string[]];

export declare const WRITE_PROBE: string;

export interface DepsHashInfo {
  source: string;
  hash: string;
}

export declare function depsHash(moduleDir: string): DepsHashInfo;
export declare function readRecordedHash(venvDir: string): string | null;

export interface ClassifyInput {
  venvExists: boolean;
  writeOk: boolean;
  importOk: boolean;
  importMissing: string[];
  depsHashOk: boolean;
  modelOk: boolean;
}

export interface ClassifyResult {
  ok: boolean;
  reason: string | null;
  action: 'none' | 'rebuild' | 'fetch-model';
  detail: string;
}

export declare function classify(input: ClassifyInput): ClassifyResult;
