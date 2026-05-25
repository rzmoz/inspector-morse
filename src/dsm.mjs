// Dependency Structure Matrix (DSM) → a single, self-contained, interactive
// HTML file (no React/Node runtime — opens straight from file://). The NDepend-
// style square matrix: rows/cols are the same ordered node set; a non-empty cell
// at (row i, col j) means "i depends on j". Run with `npm run dsm` (from
// TOW.InspectorGadget). Writes <repo>/codebase-dsm.html (gitignored).
//
// Reuses the shared ./codebase-model.mjs (same scan / import resolution /
// clustering / Tarjan SCC as graph.mjs) and renders three switchable levels:
// bounded context (4×4), namespace (~20×20), and file (every .ts/.tsx). The
// browser renderer lives in ./dsm.client.js and is inlined verbatim below.
//
// CELL COLOURS:  blue = row depends on col   green = col depends on row
//                black = mutual (cycle)       red outline = inside a cycle (SCC)
// ORDERING: "triangular" lays nodes out dependencies-first via the SCC
// condensation, so an acyclic level is purely triangular and every real cycle
// shows as a contiguous off-diagonal block. (Toggle to alphabetical in the UI.)
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { buildModel } from './codebase-model.mjs';

const config = loadConfig();
const {
  files, edges, allCtx, allGroups, byGroup, CONTEXTS,
  contextOf, ctxColour, groupOf, colourOf,
  fileScc, groupScc, ctxScc,
} = buildModel(config);

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- build one level's matrix payload ----
function buildLevel(name, nodes, nodeOf, scc, colourFor, labelFor, titleFor, ctxFor) {
  const N = nodes.length;
  const pos = new Map(nodes.map((n, i) => [n, i]));

  // weighted cells (i depends on j) + the realizing file→file imports; diagonal = intra count
  const cellMap = new Map();
  const selfW = new Array(N).fill(0);
  for (const [a, b] of edges) {
    const i = pos.get(nodeOf(a)), j = pos.get(nodeOf(b));
    if (i === undefined || j === undefined) continue;
    if (i === j) { selfW[i]++; continue; }
    const k = i + '_' + j;
    let c = cellMap.get(k);
    if (!c) { c = { i, j, w: 0, edges: [] }; cellMap.set(k, c); }
    c.w++; c.edges.push(a + '  →  ' + b);
  }
  const cells = [...cellMap.values()];

  const nodeObjs = nodes.map((n, i) => ({
    label: labelFor(n), title: titleFor(n), colour: colourFor(n),
    ctx: ctxFor(n), comp: scc.id.get(n), cycle: scc.size(n) > 1, self: selfW[i],
  }));

  // adjacency over positions (for closure + condensation)
  const adj = Array.from({ length: N }, () => new Set());
  for (const c of cells) adj[c.i].add(c.j);

  // transitive closure → indirect-only pairs (i reaches j without a direct cell)
  const reach = [];
  for (let i = 0; i < N; i++) {
    const seen = new Set(); const st = [...adj[i]];
    while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); for (const y of adj[x]) if (!seen.has(y)) st.push(y); }
    for (const j of seen) if (j !== i && !adj[i].has(j)) reach.push([i, j]);
  }

  // triangular order: condensation DFS post-order = dependencies-first; SCC
  // members stay contiguous so any cycle becomes a single off-diagonal block.
  const compId = (i) => scc.id.get(nodes[i]);
  const ncomp = scc.comps.length;
  const cadj = Array.from({ length: ncomp }, () => new Set());
  for (let i = 0; i < N; i++) for (const j of adj[i]) { const a = compId(i), b = compId(j); if (a !== b) cadj[a].add(b); }
  const compMin = new Array(ncomp).fill(null);
  for (let i = 0; i < N; i++) { const c = compId(i), lbl = nodeObjs[i].label; if (compMin[c] === null || lbl < compMin[c]) compMin[c] = lbl; }
  const byLabel = (a, b) => (compMin[a] ?? '').localeCompare(compMin[b] ?? '');
  const visited = new Set(); const post = [];
  const dfs = (c) => { visited.add(c); for (const d of [...cadj[c]].sort(byLabel)) if (!visited.has(d)) dfs(d); post.push(c); };
  for (const c of [...Array(ncomp).keys()].sort(byLabel)) if (!visited.has(c)) dfs(c);
  const members = Array.from({ length: ncomp }, () => []);
  for (let i = 0; i < N; i++) members[compId(i)].push(i);
  for (const m of members) m.sort((a, b) => nodeObjs[a].label.localeCompare(nodeObjs[b].label));
  const triGlobal = [];
  for (const c of post) triGlobal.push(...members[c]);

  // context-major: keep each bounded context as one contiguous block (ordered
  // dependencies-first, like NDepend grouping by assembly) while preserving the
  // triangular SCC order *within* each context. Context graph is acyclic, so a
  // post-order DFS gives a dependency-first context sequence; a stable partition
  // of the global triangular order by that sequence keeps SCC blocks contiguous.
  const ctxAdj = new Map([...new Set(nodeObjs.map((o) => o.ctx))].map((c) => [c, new Set()]));
  for (const cell of cells) { const ca = nodeObjs[cell.i].ctx, cb = nodeObjs[cell.j].ctx; if (ca !== cb) ctxAdj.get(ca).add(cb); }
  const cvis = new Set(); const cpost = [];
  const cdfs = (c) => { cvis.add(c); for (const d of [...ctxAdj.get(c)].sort()) if (!cvis.has(d)) cdfs(d); cpost.push(c); };
  for (const c of [...ctxAdj.keys()].sort()) if (!cvis.has(c)) cdfs(c);
  const orderTri = [];
  for (const c of cpost) for (const i of triGlobal) if (nodeObjs[i].ctx === c) orderTri.push(i);

  const orderAlpha = [...Array(N).keys()].sort((a, b) => nodeObjs[a].label.localeCompare(nodeObjs[b].label));
  const cycleCount = scc.comps.filter((c) => c.length > 1).length;
  return { name, nodes: nodeObjs, cells, reach, orderTri, orderAlpha, cycleCount };
}

const fileLabel = (f) => f.split('/').slice(-2).join('/');
const levels = {
  context: buildLevel('Bounded contexts', allCtx, contextOf, ctxScc, ctxColour, (n) => n, (n) => n, (n) => n),
  namespace: buildLevel('Namespaces', allGroups, groupOf, groupScc, colourOf, (n) => n, (n) => n, (g) => contextOf(byGroup.get(g)[0])),
  file: buildLevel('Files', files, (f) => f, fileScc, (f) => colourOf(groupOf(f)), fileLabel, (f) => f, contextOf),
};
// bounded-context colour key (CONTEXTS order, only those that actually appear) —
// the row/column header tint + legend that groups the matrix by context.
const contexts = CONTEXTS.map(([, name]) => name).filter((n) => allCtx.includes(n)).map((name) => ({ name, colour: ctxColour(name) }));

// ---- assemble the single 3-level tree (context → namespace → file) ----
// Sibling order = the dependency-first (triangular) order already computed per
// level; the client expands/collapses this tree and aggregates the file edges.
const fIndex = new Map(files.map((f, i) => [f, i]));
const ctxOrder = levels.context.orderTri.map((i) => allCtx[i]);
const nsOrderAll = levels.namespace.orderTri.map((i) => allGroups[i]);
const fileOrderAll = levels.file.orderTri.map((i) => files[i]);
const nsByCtx = new Map(ctxOrder.map((c) => [c, []]));
for (const ns of nsOrderAll) nsByCtx.get(contextOf(byGroup.get(ns)[0])).push(ns);
const filesByNs = new Map(nsOrderAll.map((ns) => [ns, []]));
for (const f of fileOrderAll) filesByNs.get(groupOf(f)).push(f);

const nodes = {};
const roots = [];
for (const c of ctxOrder) {
  const cid = 'c:' + c;
  nodes[cid] = { id: cid, kind: 'context', label: c, title: c, colour: ctxColour(c), ctx: c, parent: null, children: [], depth: 0 };
  roots.push(cid);
  for (const ns of nsByCtx.get(c)) {
    const nid = 'n:' + ns;
    nodes[nid] = { id: nid, kind: 'namespace', label: ns, title: ns, colour: colourOf(ns), ctx: c, parent: cid, children: [], depth: 1 };
    nodes[cid].children.push(nid);
    for (const f of filesByNs.get(ns)) {
      const fi = fIndex.get(f), fid = 'f:' + fi;
      nodes[fid] = { id: fid, kind: 'file', label: fileLabel(f), title: f, colour: colourOf(ns), ctx: c, parent: nid, children: [], depth: 2, fi };
      nodes[nid].children.push(fid);
    }
  }
}

// file-indexed edges + cycle (file SCC) + transitive reachability for aggregation
const edgeIdx = edges.map(([a, b]) => [fIndex.get(a), fIndex.get(b)]);
const fileComp = files.map((f) => fileScc.id.get(f));
const cycleComps = fileScc.comps.map((c, i) => [i, c.length]).filter(([, n]) => n > 1).map(([i]) => i);
const fadj = Array.from({ length: files.length }, () => []);
for (const [a, b] of edgeIdx) fadj[a].push(b);
const reachPairs = [];
for (let i = 0; i < files.length; i++) {
  const seen = new Set(); const st = [...fadj[i]];
  while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); for (const y of fadj[x]) if (!seen.has(y)) st.push(y); }
  for (const j of seen) if (j !== i) reachPairs.push([i, j]);
}

const payload = { nodes, roots, edges: edgeIdx, filePaths: files, fileComp, cycleComps, reachPairs, contexts, fileCount: files.length, edgeCount: edges.length };

// ---- assemble the single HTML file ----
const CSS = `
  *{box-sizing:border-box}
  body{margin:0;font:13px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;background:#f8fafc}
  header{padding:14px 18px 4px}
  h1{font-size:16px;margin:0 0 2px;font-weight:650}
  .meta{color:#64748b;font-size:12px}
  .controls{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:8px 18px}
  .seg{display:inline-flex;border:1px solid #cbd5e1;border-radius:7px;overflow:hidden}
  .seg button{border:0;background:#fff;padding:5px 11px;font:inherit;cursor:pointer;border-right:1px solid #e2e8f0;color:#334155}
  .seg button:last-child{border-right:0}
  .seg button.on{background:#2563eb;color:#fff}
  .legend{display:flex;gap:13px;font-size:11.5px;color:#475569;align-items:center;flex-wrap:wrap;margin-left:auto}
  .legend i{display:inline-block;width:13px;height:13px;border-radius:3px;vertical-align:-2px;margin-right:4px;border:1px solid #00000014}
  .help{padding:6px 18px;min-height:21px;color:#334155;font-size:12.5px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;background:#fff}
  .t-blue{color:#1d4ed8}.t-green{color:#15803d}.t-blk{color:#111}
  .stage{display:flex;align-items:stretch}
  .grid{overflow:auto;max-height:calc(100vh - 152px);flex:1}
  table.dsm{border-collapse:separate;border-spacing:0;font-size:11px}
  .dsm th,.dsm td{border-right:1px solid #eef2f7;border-bottom:1px solid #eef2f7}
  .dsm thead th{position:sticky;top:0;z-index:2;background:#f1f5f9;height:25px;min-width:25px;width:25px;text-align:center;color:#64748b;font-weight:600}
  .dsm .corner{left:0;z-index:4;min-width:var(--rowh);width:var(--rowh);background:#e2e8f0;text-align:left;padding:0 8px;color:#475569;font-weight:600;white-space:nowrap}
  .dsm th.rowh{position:sticky;left:0;z-index:1;background:#f8fafc;text-align:left;white-space:nowrap;max-width:var(--rowh);min-width:var(--rowh);width:var(--rowh);overflow:hidden;text-overflow:ellipsis;padding:0 8px;font-weight:500}
  .dsm th.rowh i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:0;border:1px solid #00000022}
  .dsm th.rowh b{color:#94a3b8;font-weight:600;margin-right:4px}
  .dsm td{width:25px;height:25px;min-width:25px;text-align:center;cursor:pointer;color:#fff;font-weight:600}
  .dsm td.diag{cursor:default;color:#00000055;font-weight:400}
  .dsm td.dep{background:#3b82f6}
  .dsm td.used{background:#16a34a}
  .dsm td.mutual{background:#111}
  .dsm td.dep.ind{background:#bfdbfe;color:#1e40af}
  .dsm td.used.ind{background:#bbf7d0;color:#14532d}
  .dsm td.cyc{box-shadow:inset 0 0 0 2px #dc2626}
  .dsm td.nstop,.dsm th.rowh.nstop{border-top:1px solid #cbd5e1}
  .dsm td.nsleft,.dsm thead th.nsleft{border-left:1px solid #cbd5e1}
  .dsm td.ctop,.dsm th.rowh.ctop{border-top:2px solid #94a3b8}
  .dsm td.cleft,.dsm thead th.cleft{border-left:2px solid #94a3b8}
  .dsm td.nest{background:#eceff3;cursor:default}
  .dsm th.k-context,.dsm th.k-namespace{cursor:pointer}
  .dsm th.k-context{font-weight:700}
  .dsm .tog{display:inline-block;width:13px;text-align:center;color:#64748b;user-select:none}
  .dsm .tog.sp{color:transparent}
  .dsm th.rowh .num{color:#94a3b8;font-weight:600;font-size:10px;margin:0 4px 0 2px}
  .dsm tr.hl>td,.dsm td.hlc{background-image:linear-gradient(rgba(250,204,21,.32),rgba(250,204,21,.32))}
  .dsm .hlh{background:#fde68a !important}
  .panel{flex:0 0 360px;width:360px;border-left:1px solid #e2e8f0;background:#fff;max-height:calc(100vh - 152px);overflow:auto}
  .panel.empty{display:none}
  .phead{padding:10px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;position:sticky;top:0;background:#fff}
  .pclose{float:right;cursor:pointer;color:#94a3b8;border:0;background:0;font-size:17px;line-height:1;padding:0 2px}
  .psec{padding:8px 12px;border-bottom:1px solid #f1f5f9}
  .psec h4{margin:0 0 5px;font-size:11px;letter-spacing:.02em}
  .psec .e{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#475569;padding:1px 0;white-space:nowrap}
  .psec .e.blue{color:#1d4ed8}.psec .e.green{color:#15803d}
  .ctxbar{display:flex;gap:14px;flex-wrap:wrap;align-items:center;padding:0 18px 8px;font-size:11.5px;color:#475569}
  .ctxbar b{color:#64748b;font-weight:600}
  .ctxbar i{display:inline-block;width:13px;height:13px;border-radius:3px;vertical-align:-2px;margin-right:4px;border:1px solid #00000022}
`;
const CLIENT = readFileSync(join(HERE, 'dsm.client.js'), 'utf8');

const title = config.title;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>:root{--rowh:320px}${CSS}</style></head>
<body>
<header>
  <h1>${title}</h1>
  <div class="meta" id="meta"></div>
</header>
<div class="controls">
  <div class="seg" id="xpand"><button data-act="expand">Expand all</button><button data-act="collapse">Collapse all</button></div>
  <div class="seg" data-ctl="order"><button data-val="tri">Triangular</button><button data-val="alpha">Alphabetical</button></div>
  <div class="seg" data-ctl="mode"><button data-val="direct">Direct</button><button data-val="indirect">+ Indirect</button></div>
  <div class="legend">
    <span><i style="background:#3b82f6"></i>row→col depends</span>
    <span><i style="background:#16a34a"></i>col→row depends</span>
    <span><i style="background:#111"></i>mutual</span>
    <span><i style="background:#fff;box-shadow:inset 0 0 0 2px #dc2626"></i>cycle</span>
    <span><i style="background:#bfdbfe"></i>indirect</span>
  </div>
</div>
<div class="ctxbar" id="ctxlegend"></div>
<div class="help" id="help"></div>
<div class="stage">
  <div class="grid" id="grid"></div>
  <aside class="panel empty" id="panel"><div id="pbody"></div></aside>
</div>
<script>const DATA=${JSON.stringify(payload)};</script>
<script>${CLIENT}</script>
</body></html>`;

const out = config.output.dsm;
writeFileSync(out, html, 'utf8');

// ---- console: directionality report (parity with graph.mjs) ----
console.log(`files: ${files.length} | edges: ${edges.length} | namespaces: ${allGroups.length} | contexts: ${allCtx.length}`);
const fileCycles = fileScc.comps.filter((c) => c.length > 1);
const nsCycles = groupScc.comps.filter((c) => c.length > 1);
const ctxCycles = ctxScc.comps.filter((c) => c.length > 1);
console.log(`\ncontext-level: ${ctxCycles.length ? 'CYCLE(S) — architecture violation!' : 'acyclic ✓'}`);
for (const c of ctxCycles) console.log('  ' + c.join(' <-> '));
console.log(`\nnamespace cycles (not uni-directional): ${nsCycles.length || 'none ✓'}`);
for (const comp of nsCycles) console.log('  • ' + comp.join('  <->  '));
console.log(`\nfile import cycles: ${fileCycles.length || 'none ✓'}`);
for (const comp of fileCycles) console.log('  • ' + comp.join('  <->  '));
console.log(`\nwrote: ${out} (${(html.length / 1024).toFixed(0)} KB)  — interactive DSM (open in a browser)`);
