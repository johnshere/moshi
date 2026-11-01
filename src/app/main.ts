#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';

export type Mode = 'daemon' | 'cli' | 'version';

const MODES: readonly Mode[] = ['daemon', 'cli', 'version'];

export function parseMode(argv: readonly string[]): Mode {
  const first = argv[0];
  if (first === undefined || first === '') return 'daemon';
  if (first === '--version' || first === '-v') return 'version';
  if ((MODES as readonly string[]).includes(first)) return first as Mode;
  throw new Error(`unknown mode: ${first}`);
}

export function main(argv: readonly string[]): number {
  let mode: Mode;
  try {
    mode = parseMode(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  if (mode === 'version') {
    process.stdout.write(`moshi ${VERSION}\n`);
    return 0;
  }
  process.stderr.write(`mode "${mode}" 尚未接线（P0-04 起接入 lifecycle）\n`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main(process.argv.slice(2));
}
