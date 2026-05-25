// Shared codebase model — the analysis half of the tool. Walks every .ts/.tsx
// under the configured source roots (+ any explicitly-included .d.ts), resolves
// the codebase's own relative + aliased imports into a file-dependency graph,
// clusters files into namespaces inside bounded contexts, and runs Tarjan SCC
// at all three levels (file / namespace / context). Pure Node built-ins — NO
// Graphviz. Imported by both graph.mjs (SVG) and dsm.mjs (matrix) so the two
// tools share ONE definition of "the codebase" and never drift.
//
// `buildModel(config)` is pure w.r.t. the config object — all project-specifics
// (roots, aliases, contexts, namespaces) come from inspector.gadget.json.
import { readFileSync, readdirSync } from 'node:fs';
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
  const { root, srcRoots, aliases, exclude, includeDts, contexts, namespaces } = config;
  const rel = (p) => relative(root, p).split('\\').join('/');

  // ---- collect source files ----
  const files = [];
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (exclude.includes(e.name)) continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        // include .ts/.tsx; skip .d.ts EXCEPT explicitly listed ones (contracts).
        const r = rel(p);
        if (!e.name.endsWith('.d.ts') || includeDts.includes(r)) files.push(r);
      }
    }
  }
  for (const r of srcRoots) walk(join(root, r));
  files.sort(); // deterministic order → stable SVG + clean matrix/report diffs
  const fileSet = new Set(files);

  // ---- resolve a relative/aliased import specifier to a known file ----
  function resolve(fromFile, spec) {
    let base;
    const alias = aliases.find(([a]) => spec === a || spec.startsWith(a + '/'));
    if (alias) {
      base = posix.normalize(alias[1] + spec.slice(alias[0].length)); // repo-root relative
    } else if (spec.startsWith('.')) {
      base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    } else {
      return null; // 3rd-party package
    }
    const noJs = base.replace(/\.js$/, '');
    for (const b of [base, noJs]) {
      for (const c of [b, b + '.ts', b + '.tsx', b + '/index.ts', b + '/index.tsx']) {
        if (fileSet.has(c)) return c;
      }
    }
    return null;
  }

  // ---- contexts + namespaces (from config) ----
  const contextOf = (f) => (contexts.find((c) => c.re.test(f))?.name) ?? 'other';
  const ctxColour = (n) => (contexts.find((c) => c.name === n)?.colour) ?? '#ffffff';
  const groupOf = (f) => (namespaces.find((g) => g.re.test(f))?.name) ?? 'other';
  const colourOf = (g) => (namespaces.find((g2) => g2.name === g)?.colour) ?? '#ffffff';
  // [re, name, colour] tuples — graph.mjs / dsm.mjs iterate this for layout order.
  const CONTEXTS = contexts.map((c) => [c.re, c.name, c.colour]);

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
  function addEdge(f, spec) {
    const tgt = resolve(f, spec);
    if (tgt && tgt !== f) {
      const key = f + '>' + tgt;
      if (!seen.has(key)) { seen.add(key); edges.push([f, tgt]); }
    }
  }
  for (const f of files) {
    let src;
    try { src = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    let m;
    fromRe.lastIndex = 0;
    while ((m = fromRe.exec(src))) {
      if (/^\s+type\b/.test(m[1])) continue; // `import type` / `export type` → erased, skip
      addEdge(f, m[2]);
    }
    sideRe.lastIndex = 0;
    while ((m = sideRe.exec(src))) addEdge(f, m[1]);
    dynRe.lastIndex = 0;
    while ((m = dynRe.exec(src))) addEdge(f, m[1]);
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
  };
}
