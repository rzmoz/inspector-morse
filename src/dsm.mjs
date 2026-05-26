// Combined, self-contained interactive viewer → one HTML file (no React/Node
// runtime — opens straight from file://) with two tabs:
//   • Matrix — the NDepend-style DSM (rows/cols are the same node set; a cell at
//     (row i, col j) means "i depends on j"), switchable across context /
//     namespace / file via expand-collapse.
//   • Graph — an interactive Cytoscape dependency graph (contexts + namespaces
//     always shown; click a namespace to reveal/hide its files).
// Writes <repo>/codebase-dsm.html. Run with `npm run all` / `dsm` / `graph`.
//
// Reuses the shared ./codebase-model.mjs (one scan / import resolution /
// clustering / Tarjan SCC). The matrix renderer lives in ./dsm.client.js and the
// graph renderer in ./graph.client.js; both are inlined verbatim below, along
// with Cytoscape + fcose from node_modules.
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
  files, edges, allCtx, allGroups, byGroup, contextOrder,
  contextOf, ctxColour, groupOf, colourOf,
  fileScc, groupScc, ctxScc, thirdParty, typeXctxEdges,
} = buildModel(config);

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- dependency-first ("triangular") sibling order for one level ----
// Orders the level's nodes dependencies-first via the SCC condensation, so an
// acyclic level is purely triangular and every cycle stays a contiguous block;
// then re-partitions by bounded context (the context graph is acyclic) so each
// context is one contiguous dependency-first run with its internal triangular
// order preserved — NDepend's "group by assembly". Returns indices into `nodes`.
// This ordering is all that's consumed downstream: the matrix cells, colours and
// cycle outlines are aggregated client-side from the raw file edges.
function triOrder(nodes, nodeOf, scc, labelFor, ctxFor) {
  const N = nodes.length;
  const pos = new Map(nodes.map((n, i) => [n, i]));
  const label = nodes.map(labelFor);
  const ctx = nodes.map(ctxFor);

  // position adjacency (i depends on j), self-edges dropped
  const adj = Array.from({ length: N }, () => new Set());
  for (const [a, b] of edges) {
    const i = pos.get(nodeOf(a)), j = pos.get(nodeOf(b));
    if (i === undefined || j === undefined || i === j) continue;
    adj[i].add(j);
  }

  // condensation DFS post-order = dependencies-first; SCC members stay contiguous
  // so any cycle becomes a single off-diagonal block.
  const compId = (i) => scc.id.get(nodes[i]);
  const ncomp = scc.comps.length;
  const cadj = Array.from({ length: ncomp }, () => new Set());
  for (let i = 0; i < N; i++) for (const j of adj[i]) { const a = compId(i), b = compId(j); if (a !== b) cadj[a].add(b); }
  const compMin = new Array(ncomp).fill(null);
  for (let i = 0; i < N; i++) { const c = compId(i); if (compMin[c] === null || label[i] < compMin[c]) compMin[c] = label[i]; }
  const byLabel = (a, b) => (compMin[a] ?? '').localeCompare(compMin[b] ?? '');
  const visited = new Set(); const post = [];
  const dfs = (c) => { visited.add(c); for (const d of [...cadj[c]].sort(byLabel)) if (!visited.has(d)) dfs(d); post.push(c); };
  for (const c of [...Array(ncomp).keys()].sort(byLabel)) if (!visited.has(c)) dfs(c);
  const members = Array.from({ length: ncomp }, () => []);
  for (let i = 0; i < N; i++) members[compId(i)].push(i);
  for (const m of members) m.sort((a, b) => label[a].localeCompare(label[b]));
  const triGlobal = [];
  for (const c of post) triGlobal.push(...members[c]);

  // context-major: a stable partition of the triangular order by a dependency-
  // first context sequence keeps each context contiguous and SCC blocks intact.
  const ctxAdj = new Map([...new Set(ctx)].map((c) => [c, new Set()]));
  for (let i = 0; i < N; i++) for (const j of adj[i]) { if (ctx[i] !== ctx[j]) ctxAdj.get(ctx[i]).add(ctx[j]); }
  const cvis = new Set(); const cpost = [];
  const cdfs = (c) => { cvis.add(c); for (const d of [...ctxAdj.get(c)].sort()) if (!cvis.has(d)) cdfs(d); cpost.push(c); };
  for (const c of [...ctxAdj.keys()].sort()) if (!cvis.has(c)) cdfs(c);
  const order = [];
  for (const c of cpost) for (const i of triGlobal) if (ctx[i] === c) order.push(i);
  return order;
}

const fileLabel = (f) => f.split('/').slice(-2).join('/');
const ctxOrderIdx = triOrder(allCtx, contextOf, ctxScc, (n) => n, (n) => n);
const nsOrderIdx = triOrder(allGroups, groupOf, groupScc, (n) => n, (g) => contextOf(byGroup.get(g)[0]));
const fileOrderIdx = triOrder(files, (f) => f, fileScc, fileLabel, contextOf);
// bounded-context colour key (sorted context order, only those that appear) —
// the row/column header tint + legend that groups the matrix by context.
const contexts = contextOrder.filter((n) => allCtx.includes(n)).map((name) => ({ name, colour: ctxColour(name) }));

// ---- assemble the single 3-level tree (context → namespace → file) ----
// Sibling order = the dependency-first (triangular) order already computed per
// level; the client expands/collapses this tree and aggregates the file edges.
const fIndex = new Map(files.map((f, i) => [f, i]));
const ctxOrder = ctxOrderIdx.map((i) => allCtx[i]);
const nsOrderAll = nsOrderIdx.map((i) => allGroups[i]);
const fileOrderAll = fileOrderIdx.map((i) => files[i]);
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

// ---- third-party reference nodes (external packages). Modelled as synthetic
// sink "files" appended to the index space so the matrix aggregation handles
// them with no change; they carry no SCC/reachability (pure sinks). Rendered
// purple and pinned to the bottom by the client; toggleable in the UI. ----
const TP_CTX = '(third-party)', TP_CTX_COLOUR = '#e9d5ff', TP_NODE_COLOUR = '#d8b4fe';
const packages = thirdParty.packages;
const tpFi = new Map(packages.map((p, i) => [p, files.length + i]));
const tpCtxId = 'c:' + TP_CTX;
if (packages.length) {
  nodes[tpCtxId] = { id: tpCtxId, kind: 'context', label: TP_CTX, title: TP_CTX + ' — external references', colour: TP_CTX_COLOUR, ctx: TP_CTX, parent: null, children: [], depth: 0, tp: true };
  roots.push(tpCtxId);
  for (const pkg of packages) {
    const nid = 'n:' + pkg, fi = tpFi.get(pkg), fid = 'f:' + fi;
    nodes[nid] = { id: nid, kind: 'namespace', label: pkg, title: pkg, colour: TP_NODE_COLOUR, ctx: TP_CTX, parent: tpCtxId, children: [fid], depth: 1, tp: true };
    nodes[tpCtxId].children.push(nid);
    nodes[fid] = { id: fid, kind: 'file', label: pkg, title: pkg, colour: TP_NODE_COLOUR, ctx: TP_CTX, parent: nid, children: [], depth: 2, fi, tp: true };
  }
  contexts.push({ name: TP_CTX, colour: TP_CTX_COLOUR });
}
const tpEdgeIdx = thirdParty.edges.map(([f, pkg]) => [fIndex.get(f), tpFi.get(pkg)]);

// ---- graph-tab data (first-party only; third-party omitted from the graph) ----
// Contexts = compound parents, namespaces = collapsible compounds, files =
// leaves. We ship the FULL file→file edge list with per-edge metadata; the
// client routes each edge to the deepest visible node on each end (file when its
// namespace is expanded, else the namespace), aggregates duplicates, and colours
// by relationship — so unfolding a namespace reattaches edges to its files.
const gCtxOf = new Map(allGroups.map((g) => [g, contextOf(byGroup.get(g)[0])]));
const gNodes = [];
for (const c of allCtx) gNodes.push({ id: 'c:' + c, label: c, kind: 'context', colour: ctxColour(c) });
for (const g of allGroups) gNodes.push({ id: 'n:' + g, parent: 'c:' + gCtxOf.get(g), label: g.split(' · ').pop(), kind: 'namespace', colour: colourOf(g), title: g });
for (const f of files) gNodes.push({ id: 'f:' + fIndex.get(f), parent: 'n:' + groupOf(f), label: f.split('/').pop(), kind: 'file', colour: colourOf(groupOf(f)), title: f });
const gFileEdges = [];
for (const [a, b] of edges) {
  const na = groupOf(a), nb = groupOf(b);
  const nsCyc = na !== nb && groupScc.id.get(na) === groupScc.id.get(nb) && groupScc.size(na) > 1;
  const fileCyc = fileScc.id.get(a) === fileScc.id.get(b) && fileScc.size(a) > 1;
  gFileEdges.push({ s: 'f:' + fIndex.get(a), t: 'f:' + fIndex.get(b), ns1: 'n:' + na, ns2: 'n:' + nb, ctx1: 'c:' + contextOf(a), ctx2: 'c:' + contextOf(b), nsCyc, fileCyc });
}
// type-only cross-context edges — graph-only (kept out of edges/SCC); always crossCtx
for (const [a, b] of typeXctxEdges) {
  gFileEdges.push({ s: 'f:' + fIndex.get(a), t: 'f:' + fIndex.get(b), ns1: 'n:' + groupOf(a), ns2: 'n:' + groupOf(b), ctx1: 'c:' + contextOf(a), ctx2: 'c:' + contextOf(b), nsCyc: false, fileCyc: false });
}
const graph = { nodes: gNodes, fileEdges: gFileEdges };

const payload = { nodes, roots, edges: [...edgeIdx, ...tpEdgeIdx], filePaths: [...files, ...packages], fileComp, cycleComps, reachPairs, contexts, thirdPartyCtxId: packages.length ? tpCtxId : null, fileCount: files.length, edgeCount: edges.length, tpCount: packages.length, graph };

// ---- assemble the single HTML file ----
const CSS = `
  *{box-sizing:border-box}
  body{margin:0;font:13px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;background:#f8fafc}
  header{padding:12px 18px 4px}
  h1{font-size:16px;margin:0 0 4px;font-weight:650}
  .meta{color:#64748b;font-size:12px}
  .tabs{display:inline-flex;gap:5px;margin:0 0 4px}
  .tabs button{border:1px solid #cbd5e1;background:#fff;padding:4px 16px;font:inherit;font-weight:600;cursor:pointer;border-radius:7px;color:#334155}
  .tabs button.on{background:#2563eb;color:#fff;border-color:#2563eb}
  .gbtn{border:1px solid #cbd5e1;background:#fff;padding:5px 11px;font:inherit;cursor:pointer;border-radius:7px;color:#334155}
  #graphpane{position:relative}
  #cy{width:100%;height:calc(100vh - 150px);background:#f8fafc}
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
  .dsm thead th{position:sticky;top:0;z-index:2;background:#f1f5f9;height:var(--colh);min-width:25px;width:25px;text-align:center;color:#64748b;font-weight:600;vertical-align:bottom;padding:0}
  .dsm thead .chl{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;padding:0 0 4px;gap:3px}
  .dsm thead .cname{writing-mode:vertical-rl;max-height:calc(var(--colh) - 22px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:#334155}
  .dsm thead .cnum{color:#94a3b8;font-size:10px;font-weight:600}
  .dsm .corner{left:0;z-index:4;min-width:var(--rowh);width:var(--rowh);background:#e2e8f0;text-align:left;padding:0 8px 6px;color:#475569;font-weight:600;white-space:nowrap;vertical-align:bottom}
  .dsm th.rowh{position:sticky;left:0;z-index:1;background:#f8fafc;text-align:left;white-space:nowrap;max-width:var(--rowh);min-width:var(--rowh);width:var(--rowh);overflow:hidden;text-overflow:ellipsis;padding:0 8px;font-weight:500}
  .dsm th.rowh i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:0;border:1px solid #00000022}
  .dsm th.rowh b{color:#94a3b8;font-weight:600;margin-right:4px}
  .dsm td{width:25px;height:25px;min-width:25px;text-align:center;cursor:pointer;color:#fff;font-weight:600;background:#ffffff}
  .dsm td.tpcell{background:#f3ebfc}
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
const GRAPH_CLIENT = readFileSync(join(HERE, 'graph.client.js'), 'utf8');
const LIBS = ['cytoscape/dist/cytoscape.min.js', 'layout-base/layout-base.js', 'cose-base/cose-base.js', 'cytoscape-fcose/cytoscape-fcose.js']
  .map((p) => readFileSync(join(HERE, '..', 'node_modules', p), 'utf8')).join('\n;\n');

const title = config.title;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>:root{--rowh:320px;--colh:170px}${CSS}</style></head>
<body>
<header>
  <h1>${title}</h1>
  <div class="tabs"><button data-tab="matrix" class="on">Matrix</button><button data-tab="graph">Graph</button></div>
  <div class="meta" id="meta"></div>
</header>
<div id="matrixpane">
  <div class="controls">
    <div class="seg" id="xpand"><button data-act="expand">Expand all</button><button data-act="collapse">Collapse all</button></div>
    <div class="seg" data-ctl="order"><button data-val="tri">Triangular</button><button data-val="alpha">Alphabetical</button></div>
    <div class="seg" data-ctl="mode"><button data-val="direct">Direct</button><button data-val="indirect">+ Indirect</button></div>
    <div class="seg" data-ctl="tp"><button data-val="show">3rd-party</button><button data-val="hide">hide</button></div>
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
</div>
<div id="graphpane" style="display:none">
  <div class="controls">
    <div class="seg"><button data-g="expand">Expand all</button><button data-g="collapse">Collapse all</button></div>
    <button class="gbtn" data-g="fit">Fit</button>
    <button class="gbtn" data-g="relayout">Re-layout</button>
    <div class="legend">
      <span><i style="background:#7b2ff7"></i>cross-context</span>
      <span><i style="background:#ff8c00"></i>namespace cycle</span>
      <span><i style="background:#3b82f6"></i>forward</span>
      <span><i style="background:#b8c0cc"></i>intra (file)</span>
      <span><i style="background:#dd0000"></i>file cycle</span>
    </div>
  </div>
  <div id="cy"></div>
</div>
<script>${LIBS}</script>
<script>const DATA=${JSON.stringify(payload)};</script>
<script>${CLIENT}</script>
<script>${GRAPH_CLIENT}</script>
<script>
(function () {
  const tabs = document.querySelectorAll('.tabs button');
  const mp = document.getElementById('matrixpane'), gp = document.getElementById('graphpane');
  tabs.forEach((b) => b.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('on', x === b));
    const t = b.dataset.tab;
    mp.style.display = t === 'matrix' ? '' : 'none';
    gp.style.display = t === 'graph' ? '' : 'none';
    if (t === 'graph' && window.IGGraph) { IGGraph.init(document.getElementById('cy')); IGGraph.resize(); IGGraph.fit(); }
  }));
  document.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
    if (!window.IGGraph) return;
    ({ expand: IGGraph.expandAll, collapse: IGGraph.collapseAll, fit: IGGraph.fit, relayout: IGGraph.relayout }[b.dataset.g] || (() => {}))();
  }));
})();
</script>
</body></html>`;

const out = config.output.dsm;
writeFileSync(out, html, 'utf8');

// ---- console: directionality report ----
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
console.log(`\nwrote: ${out} (${(html.length / 1024).toFixed(0)} KB)  — interactive viewer: Matrix + Graph tabs (open in a browser)`);
