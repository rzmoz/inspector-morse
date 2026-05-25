// Shared codebase model — the analysis half of the tool. Walks every .ts/.tsx
// under the derived source roots (+ any explicitly-included .d.ts), resolves
// the codebase's own relative imports into a file-dependency graph, clusters
// files into namespaces inside bounded contexts, and runs Tarjan SCC at all
// three levels (file / namespace / context). Non-relative imports that don't
// resolve to a scanned file (npm packages, etc.) are collected separately as
// THIRD-PARTY references (consumed only by the DSM). Pure Node built-ins — NO
// Graphviz. Imported by both graph.mjs (SVG) and dsm.mjs (matrix) so the two
// tools share ONE definition of "the codebase" and never drift.
//
// `buildModel(config)` derives contexts (top-level dirs), source roots (each
// context's `src/`, else itself) and namespaces (first segment below the source
// root) from the directory tree; only exclude / includeDts / title / output
// come from inspector.gadget.json.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, posix } from 'node:path';

// ---- Tarjan SCC (generic) ----
export function sccOf(nodes, adj) {
  let idx = 0; const stack = []; const onStack = new Set();
  const index = new Map(); const low = new Map(); const comps = [];
  const id = new Map(); // node -> component index
  function strong(v) {
    index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = []; let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      const ci = comps.length; comps.push(comp);
      for (const n of comp) id.set(n, ci);
    }
  }
  for (const n of nodes) if (!index.has(n)) strong(n);
  return { comps, id, size: (n) => comps[id.get(n)].length };
}

export function buildModel(config) {
  const { root, exclude, includeDts } = config;
  const rel = (p) => relative(root, p).split('\\').join('/');

  // ---- discover bounded contexts + their source roots from the directory tree ----
  // Each immediate child dir of the project root (the settings-file dir) is a
  // bounded CONTEXT — skipping excluded names and dot-dirs. A context's SOURCE
  // ROOT is its `src/` subdir if present, else the context dir itself (e.g. a
  // `.d.ts`-only contract package). This replaces the old `srcRoots` config:
  // the scan scope is DERIVED from the layout, not declared.
  const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  const contextDirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !exclude.includes(e.name))
    .map((e) => e.name)
    .sort();
  const srcRootOf = new Map(contextDirs.map((c) => [c, isDir(join(root, c, 'src')) ? `${c}/src` : c]));

  // ---- collect source files, tagging each with its context + namespace ----
  // CONTEXT = the top-level dir. NAMESPACE = first path segment beneath the
  // source root (files directly in the source root → "(root)"), qualified by
  // context so names are unique and group cleanly (e.g. "TOW.EDB · pipeline").
  const files = [];
  const fileCtx = new Map();
  const fileNs = new Map();
  function walk(dir, ctx, srcRoot) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (exclude.includes(e.name)) continue;
        walk(p, ctx, srcRoot);
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        // include .ts/.tsx; skip .d.ts EXCEPT explicitly listed ones (contracts).
        const r = rel(p);
        if (e.name.endsWith('.d.ts') && !includeDts.includes(r)) continue;
        files.push(r);
        fileCtx.set(r, ctx);
        const rest = r.startsWith(srcRoot + '/') ? r.slice(srcRoot.length + 1) : r;
        const slash = rest.indexOf('/');
        fileNs.set(r, `${ctx} · ${slash >= 0 ? rest.slice(0, slash) : '(root)'}`);
      }
    }
  }
  for (const c of contextDirs) walk(join(root, srcRootOf.get(c)), c, srcRootOf.get(c));
  files.sort(); // deterministic order → stable SVG + clean matrix/report diffs
  const fileSet = new Set(files);

  // ---- resolve a relative import specifier to a known file (null otherwise) ----
  // Only relative specs are internal. Non-relative specs (packages) never map to
  // a scanned file — they're handled as third-party references below.
  function resolve(fromFile, spec) {
    if (!spec.startsWith('.')) return null;
    const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    const noJs = base.replace(/\.js$/, '');
    for (const b of [base, noJs]) {
      for (const c of [b, b + '.ts', b + '.tsx', b + '/index.ts', b + '/index.tsx']) {
        if (fileSet.has(c)) return c;
      }
    }
    return null;
  }

  // ---- third-party package root for a non-relative specifier ----
  // node: builtins are dropped; "@scope/name" → first two segments; otherwise
  // the first segment. Returns null for builtins (→ ignored).
  function pkgRoot(spec) {
    if (spec.startsWith('node:')) return null;
    const parts = spec.split('/');
    return spec.startsWith('@') && parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0];
  }

  // ---- contexts + namespaces (auto-derived; colours from deterministic palettes) ----
  // Hand-picked tints are gone: contexts/namespaces are coloured by sorted name
  // from fixed pastel palettes (cycled), so output stays stable across runs.
  const CTX_PALETTE = ['#eaf2ff', '#fdeef0', '#ecfbef', '#fff5d6', '#f3e8ff', '#e6fbfb', '#fef3e2', '#eef2f7'];
  const NS_PALETTE = ['#cfe8ff', '#ffd1dc', '#d6f5d6', '#ffe9a6', '#e6c9e0', '#cfe8e0', '#ffdfba', '#d9d9d9', '#ffc9c9', '#cce5ff', '#ffe0b3', '#ffb3ba', '#c9e4ff', '#d6d6f5', '#f5d6d6', '#d6f5ec'];
  const usedCtx = [...new Set(files.map((f) => fileCtx.get(f)))].sort();
  const usedNs = [...new Set(files.map((f) => fileNs.get(f)))].sort();
  const ctxColourMap = new Map(usedCtx.map((c, i) => [c, CTX_PALETTE[i % CTX_PALETTE.length]]));
  const nsColourMap = new Map(usedNs.map((g, i) => [g, NS_PALETTE[i % NS_PALETTE.length]]));
  const contextOf = (f) => fileCtx.get(f) ?? 'other';
  const ctxColour = (n) => ctxColourMap.get(n) ?? '#ffffff';
  const groupOf = (f) => fileNs.get(f) ?? 'other';
  const colourOf = (g) => nsColourMap.get(g) ?? '#ffffff';
  // [_, name, colour] tuples in sorted context order — graph.mjs / dsm.mjs read name (+colour).
  const CONTEXTS = usedCtx.map((c) => [c, c, ctxColourMap.get(c)]);

  // ---- build edges (file → file import dependencies) ----
  // Whole-statement type-only imports/exports (`import type … from`,
  // `export type … from`) erase at build — they are NOT runtime/bundle
  // dependencies, so they are excluded and must not form cycles. (Inline
  // `import { type X }` mixed with value specifiers is kept: it still leaves a
  // real value edge.) Side-effect (`import 'x'`) and dynamic / require count.
  const fromRe = /\b(?:import|export)\b([^'";]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  const sideRe = /\bimport\s+['"]([^'"]+)['"]/g;
  const dynRe = /(?:\bimport\b|\brequire)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const edges = [];
  const seen = new Set();
  function addInternal(f, tgt) {
    if (tgt && tgt !== f) {
      const key = f + '>' + tgt;
      if (!seen.has(key)) { seen.add(key); edges.push([f, tgt]); }
    }
  }
  // third-party reference edges (file → external package). Collected for the DSM
  // only: they never enter `edges`/SCC, so first-party cycle analysis and the
  // namespace SVG stay first-party. Unlike internal edges, type-only imports
  // DO count here (a `import type … from 'pkg'` is still a real reference).
  const tpEdges = [];
  const tpSeen = new Set();
  const tpPkgs = new Set();
  function addExternal(f, spec) {
    if (spec.startsWith('.')) return; // relative-but-unresolved (asset/json) → ignore
    const pkg = pkgRoot(spec);
    if (!pkg) return;                 // node: builtin
    tpPkgs.add(pkg);
    const key = f + '>' + pkg;
    if (!tpSeen.has(key)) { tpSeen.add(key); tpEdges.push([f, pkg]); }
  }
  for (const f of files) {
    let src;
    try { src = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    let m;
    fromRe.lastIndex = 0;
    while ((m = fromRe.exec(src))) {
      const typeOnly = /^\s+type\b/.test(m[1]); // `import type`/`export type` → erased at build
      const tgt = resolve(f, m[2]);
      if (tgt) { if (!typeOnly) addInternal(f, tgt); } // type-only internal still excluded
      else addExternal(f, m[2]);                       // external ref (type-only counts)
    }
    sideRe.lastIndex = 0;
    while ((m = sideRe.exec(src))) { const t = resolve(f, m[1]); if (t) addInternal(f, t); else addExternal(f, m[1]); }
    dynRe.lastIndex = 0;
    while ((m = dynRe.exec(src))) { const t = resolve(f, m[1]); if (t) addInternal(f, t); else addExternal(f, m[1]); }
  }

  // file-level SCCs
  const fAdj = new Map(files.map((f) => [f, []]));
  for (const [a, b] of edges) fAdj.get(a).push(b);
  const fileScc = sccOf(files, fAdj);

  // namespace-level SCCs (group graph)
  const allGroups = [...new Set(files.map(groupOf))];
  const gAdj = new Map(allGroups.map((g) => [g, new Set()]));
  for (const [a, b] of edges) { const ga = groupOf(a), gb = groupOf(b); if (ga !== gb) gAdj.get(ga).add(gb); }
  const gAdjArr = new Map([...gAdj].map(([g, s]) => [g, [...s]]));
  const groupScc = sccOf(allGroups, gAdjArr);

  // context-level SCCs (sanity: must be acyclic)
  const allCtx = [...new Set(files.map(contextOf))];
  const cAdj = new Map(allCtx.map((c) => [c, new Set()]));
  for (const [a, b] of edges) { const ca = contextOf(a), cb = contextOf(b); if (ca !== cb) cAdj.get(ca).add(cb); }
  const ctxScc = sccOf(allCtx, new Map([...cAdj].map(([c, s]) => [c, [...s]])));

  // ---- group bookkeeping (used by the namespace SVG, the report, and the matrix) ----
  const byGroup = new Map();
  for (const f of files) { if (!byGroup.has(groupOf(f))) byGroup.set(groupOf(f), []); byGroup.get(groupOf(f)).push(f); }
  const groupsByCtx = new Map();
  for (const g of byGroup.keys()) {
    const ctx = contextOf(byGroup.get(g)[0]);
    if (!groupsByCtx.has(ctx)) groupsByCtx.set(ctx, []);
    groupsByCtx.get(ctx).push(g);
  }

  return {
    files, edges,
    fileScc, groupScc, ctxScc,
    allGroups, allCtx, gAdj, byGroup, groupsByCtx,
    contextOf, ctxColour, groupOf, colourOf, CONTEXTS,
    thirdParty: { packages: [...tpPkgs].sort(), edges: tpEdges },
  };
}
