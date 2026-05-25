#!/usr/bin/env node
// inspector.gadget CLI.
//
//   inspector.gadget [graph|dsm|all] [--config <path>]
//
// Resolves the settings file (--config, else $IG_CONFIG_PATH, else the nearest
// inspector.gadget.json walking up from the current directory). Outputs default
// to that file's directory. All three commands now emit the same single
// combined viewer (Matrix + Graph tabs); the names are kept for familiarity.
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) ?? 'all';
const ci = args.indexOf('--config');
if (ci >= 0 && args[ci + 1]) process.env.IG_CONFIG_PATH = resolve(args[ci + 1]);

if (!['graph', 'dsm', 'all'].includes(cmd)) {
  console.error(`unknown command "${cmd}". usage: inspector.gadget [graph|dsm|all] [--config <path>]`);
  process.exit(1);
}

// The renderer self-runs on import (reads the config via loadConfig) and writes
// the combined Matrix + Graph viewer in one pass.
await import('../src/dsm.mjs');
