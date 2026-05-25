#!/usr/bin/env node
// inspector.gadget CLI.
//
//   inspector.gadget [graph|dsm|all] [--config <path>]
//
// Resolves the settings file (--config, else $IG_CONFIG_PATH, else the nearest
// inspector.gadget.json walking up from the current directory). Outputs default
// to that file's directory. `all` (the default) emits both the graph SVG and
// the DSM HTML in one pass.
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) ?? 'all';
const ci = args.indexOf('--config');
if (ci >= 0 && args[ci + 1]) process.env.IG_CONFIG_PATH = resolve(args[ci + 1]);

if (!['graph', 'dsm', 'all'].includes(cmd)) {
  console.error(`unknown command "${cmd}". usage: inspector.gadget [graph|dsm|all] [--config <path>]`);
  process.exit(1);
}

// The renderers self-run on import (each reads the config via loadConfig);
// importing in sequence runs graph then dsm in a single process.
if (cmd === 'graph' || cmd === 'all') await import('../src/graph.mjs');
if (cmd === 'dsm' || cmd === 'all') await import('../src/dsm.mjs');
