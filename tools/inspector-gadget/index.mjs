#!/usr/bin/env node
// Orchestrator: detect ecosystem(s) under <code-root>, run the matching
// analyzer(s) (TS in-process; .NET via `dotnet run` helper), merge their raw
// shapes, finalize the shared Model, render codebase-dsm.html.
//
// CLI: inspector-gadget <code-root> [--ecosystem=ts|dotnet|auto] [-h]
//      Aliases: --code-root <dir> / --code-root=<dir> (positional preferred).
//
// stdout: compact JSON summary (consumed by the /inspector-gadget slash command).
// stderr: human-readable report.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as analyzeTs from './analyze-ts.mjs';
import { assemble } from './model.mjs';
import { render } from './render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, 'assets');
const DOTNET_HELPER = path.join(__dirname, 'analyze-dotnet', 'analyze-dotnet.csproj');

const USAGE =
  'usage: inspector-gadget <code-root> [--ecosystem=ts|dotnet|auto] [-h|--help]\n' +
  '\n' +
  '  <code-root>            project root to scan (required, positional)\n' +
  '  --code-root <dir>      alias for the positional arg\n' +
  '  --ecosystem=<v>        ts | dotnet | auto (default: auto-detect)\n' +
  '  -h, --help             show this help and exit\n' +
  '\n' +
  'Writes <code-root>/codebase-dsm.html and prints a JSON summary to stdout.';

function parseArgs(argv) {
  let help = false, ecosystem = 'auto', root = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { help = true; continue; }
    if (a === '--code-root') { root = argv[++i]; continue; }
    if (a.startsWith('--code-root=')) { root = a.slice('--code-root='.length); continue; }
    if (a === '--ecosystem') { ecosystem = argv[++i]; continue; }
    if (a.startsWith('--ecosystem=')) { ecosystem = a.slice('--ecosystem='.length); continue; }
    if (a.length > 1 && a.startsWith('-')) { throw new Error(`unknown option '${a}'`); }
    if (root == null) { root = a; continue; }
    throw new Error(`unexpected positional '${a}'`);
  }
  return { help, ecosystem, root };
}

// shallow + targeted: walk skipping node_modules/bin/obj/dist/build/.git etc.,
// stop as soon as both flags are set or budget exhausted.
function detect(root) {
  const skip = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', '.git', '.vs', '.idea']);
  let ts = false, dotnet = false, budget = 5000;
  function walk(dir) {
    if (budget-- <= 0 || (ts && dotnet)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const name = e.name;
      if (e.isDirectory()) {
        if (name.startsWith('.') || skip.has(name)) continue;
        walk(path.join(dir, name));
        if (ts && dotnet) return;
      } else {
        if (!dotnet && (name.endsWith('.csproj') || name.endsWith('.sln'))) dotnet = true;
        if (!ts && (name.endsWith('.ts') || name.endsWith('.tsx') || /^tsconfig.*\.json$/.test(name))) ts = true;
        if (ts && dotnet) return;
      }
    }
  }
  walk(root);
  return { ts, dotnet };
}

function runDotnetHelper(root) {
  const res = spawnSync('dotnet', ['run', '--project', DOTNET_HELPER, '-c', 'Release', '--', root], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024, // some codebases have huge type graphs
  });
  if (res.error) throw new Error(`failed to launch dotnet: ${res.error.message}`);
  if (res.status !== 0) {
    process.stderr.write(res.stderr || '');
    throw new Error(`dotnet helper exited ${res.status}`);
  }
  // helper prints build banners to stderr; stdout is the raw JSON only.
  try { return JSON.parse(res.stdout); }
  catch (e) { throw new Error(`could not parse dotnet helper output: ${e.message}`); }
}

function mergeRaw(parts) {
  const out = { files: [], fileCtx: {}, fileNs: {}, edges: [], tpEdges: [], tpPkgs: [], typeXctxEdges: [] };
  for (const p of parts) {
    out.files.push(...p.files);
    Object.assign(out.fileCtx, p.fileCtx);
    Object.assign(out.fileNs, p.fileNs);
    out.edges.push(...p.edges);
    out.tpEdges.push(...p.tpEdges);
    out.tpPkgs.push(...p.tpPkgs);
    out.typeXctxEdges.push(...p.typeXctxEdges);
  }
  out.files.sort(); // deterministic merged order
  return out;
}

function main(argv) {
  let cli;
  try { cli = parseArgs(argv); }
  catch (e) { process.stderr.write(`error: ${e.message}\n\n${USAGE}\n`); return 1; }
  if (cli.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (!cli.root) { process.stderr.write(`error: missing <code-root>\n\n${USAGE}\n`); return 1; }

  const root = path.resolve(cli.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`error: not a directory: ${root}\n`); return 1;
  }

  let want = cli.ecosystem;
  if (!['auto', 'ts', 'dotnet'].includes(want)) {
    process.stderr.write(`error: --ecosystem must be ts|dotnet|auto (got '${want}')\n`); return 1;
  }
  let eco;
  if (want === 'auto') {
    eco = detect(root);
    if (!eco.ts && !eco.dotnet) {
      process.stderr.write(`error: no .csproj/.sln and no .ts/tsconfig found under ${root}\n` +
        `       use --ecosystem to force one if your layout is unusual.\n`); return 1;
    }
  } else {
    eco = { ts: want === 'ts', dotnet: want === 'dotnet' };
  }

  const parts = [];
  if (eco.ts) {
    process.stderr.write(`[ts] analyzing ${root}\n`);
    parts.push(analyzeTs.build(root));
  }
  if (eco.dotnet) {
    process.stderr.write(`[dotnet] analyzing ${root} (via dotnet run helper)\n`);
    parts.push(runDotnetHelper(root));
  }

  const raw = parts.length === 1 ? parts[0] : mergeRaw(parts);
  const model = assemble(raw);

  const title = path.basename(root) || root;
  const outputDsm = path.join(root, 'codebase-dsm.html');
  render(model, { root, title, outputDsm, assetsDir: ASSETS_DIR });
  return 0;
}

const code = main(process.argv.slice(2));
process.exit(code);
