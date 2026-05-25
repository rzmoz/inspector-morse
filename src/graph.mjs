// Full-codebase import-dependency graph → high-res SVG (vector, zoomable).
// Lives in TOW.InspectorGadget because it's an inspection feature spanning ALL
// sub-projects (sibling to the visual inspector; may become an inspector tab).
// Run with `npm run graph` (from TOW.InspectorGadget). Writes at <repo>:
//   codebase-graph.namespaces.svg — namespace level (the high-level overview)
//   codebase-graph.svg            — file level (every .ts/.tsx) — DISABLED (flip EMIT_FILE_LEVEL)
//
// The codebase scan / import resolution / clustering / SCC analysis lives in the
// shared ./codebase-model.mjs (also used by dsm.mjs). This file is only the
// Graphviz rendering + the directionality console report.
//
// EDGE COLOURS encode directionality health (a clean codebase shows none of the
// first two):
//   red    = file-level import cycle (two files import each other, directly or
//            transitively) — a hard cycle.
//   orange = namespace cycle: two clusters point at each other (not necessarily
//            the same files). The signal that a bounded context is NOT
//            internally uni-directional.
//   purple = cross-context edge (between TOW.EDB / TOW.BattleBuddy / Inspector).
//   blue   = forward cross-namespace edge inside one context (healthy layering).
//   grey   = intra-namespace edge.
import { writeFileSync } from 'fs';
import { Graphviz } from '@hpcc-js/wasm';
import { loadConfig } from './config.mjs';
import { buildModel } from './codebase-model.mjs';

const config = loadConfig();
const {
  files, edges, CONTEXTS, contextOf, ctxColour, groupOf, colourOf,
  fileScc, groupScc, ctxScc, allGroups, gAdj, byGroup, groupsByCtx,
} = buildModel(config);

// ---- classify each edge ----
function edgeKind(a, b) {
  if (fileScc.id.get(a) === fileScc.id.get(b) && fileScc.size(a) > 1) return 'fileCycle';
  const ga = groupOf(a), gb = groupOf(b);
  if (ga !== gb && groupScc.id.get(ga) === groupScc.id.get(gb) && groupScc.size(ga) > 1) return 'nsCycle';
  if (contextOf(a) !== contextOf(b)) return 'crossCtx';
  if (ga !== gb) return 'crossNs';
  return 'intra';
}
const EDGE_STYLE = {
  fileCycle: 'color="#dd0000", penwidth=2.6, arrowsize=0.9',
  nsCycle:   'color="#ff8c00", penwidth=2.0, arrowsize=0.8',
  crossCtx:  'color="#7b2ff7", penwidth=1.8, arrowsize=0.8',
  crossNs:   'color="#3b82f6aa", penwidth=1.0',
  intra:     'color="#bbbbbb66", penwidth=0.6',
};

const graphviz = await Graphviz.load();

// ---- file-level SVG (detailed, every .ts/.tsx) — DISABLED for now ----
// Flip EMIT_FILE_LEVEL to true to regenerate codebase-graph.svg.
const EMIT_FILE_LEVEL = config.output.emitFileLevel;
if (EMIT_FILE_LEVEL) {
  const id = (f) => '"' + f + '"';
  const label = (f) => f.split('/').pop().replace(/\.(ts|tsx)$/, '');
  let dot = 'digraph codebase {\n';
  dot += '  graph [rankdir=LR, splines=true, overlap=false, nodesep=0.25, ranksep=1.4, fontname="Helvetica", fontsize=20, compound=true, bgcolor="white"];\n';
  dot += '  node [shape=box, style="filled,rounded", fontname="Helvetica", fontsize=11, margin="0.08,0.04", penwidth=0.6];\n';
  dot += '  edge [arrowsize=0.6, penwidth=0.6];\n';
  let ci = 0;
  for (const [ctx, groups] of groupsByCtx) {
    dot += `  subgraph "cluster_ctx_${ci++}" {\n    label="${ctx}"; style="filled,rounded"; fillcolor="${ctxColour(ctx)}"; color="#888888"; penwidth=2.5; fontsize=34; fontname="Helvetica-Bold"; labelloc="t";\n`;
    for (const g of groups) {
      dot += `    subgraph "cluster_${ci++}" {\n      label="${g}"; style="filled"; color="#bbbbbb"; fillcolor="${colourOf(g)}cc"; fontsize=20; fontname="Helvetica-Bold";\n`;
      for (const f of byGroup.get(g)) dot += `      ${id(f)} [label="${label(f)}", fillcolor="${colourOf(g)}", tooltip="${f}"];\n`;
      dot += '    }\n';
    }
    dot += '  }\n';
  }
  for (const [a, b] of edges) dot += `  ${id(a)} -> ${id(b)} [${EDGE_STYLE[edgeKind(a, b)]}];\n`;
  dot += '  labelloc="b"; labeljust="l"; fontsize=16; fontname="Helvetica";\n';
  dot += '  label="edge colours:  red = file import cycle   orange = namespace cycle   purple = cross-context   blue = forward cross-namespace   grey = intra-namespace";\n';
  dot += '}\n';
  const svg = graphviz.layout(dot, 'svg', 'dot');
  const out = config.output.fileLevelGraph;
  writeFileSync(out, svg, 'utf8');
  console.log(`wrote: ${out} (${(svg.length / 1024).toFixed(0)} KB)  — file level`);
}

// ---- console: directionality report ----
console.log(`files: ${files.length} | edges: ${edges.length} | namespaces: ${byGroup.size} | contexts: ${groupsByCtx.size}`);
const fileCycles = fileScc.comps.filter((c) => c.length > 1);
const nsCycles = groupScc.comps.filter((c) => c.length > 1);
const ctxCycles = ctxScc.comps.filter((c) => c.length > 1);

console.log(`\ncontext-level: ${ctxCycles.length ? 'CYCLE(S) — architecture violation!' : 'acyclic ✓'}`);
for (const c of ctxCycles) console.log('  ' + c.join(' <-> '));

console.log(`\nnamespace cycles (not uni-directional): ${nsCycles.length || 'none ✓'}`);
for (const comp of nsCycles) {
  console.log('  • ' + comp.join('  <->  '));
  const realized = edges.filter(([a, b]) => { const ga = groupOf(a), gb = groupOf(b); return ga !== gb && comp.includes(ga) && comp.includes(gb); });
  for (const [a, b] of realized) console.log(`      ${a}  →  ${b}   [${groupOf(a)} → ${groupOf(b)}]`);
}

console.log(`\nfile import cycles: ${fileCycles.length || 'none ✓'}`);
for (const comp of fileCycles) console.log('  • ' + comp.join('  <->  '));

// ---- second SVG: namespace-level overview (the same high-level view) ----
// Namespaces as nodes, clustered into the bounded-context backgrounds; edges are
// namespace→namespace, coloured by directionality health. Nodes/edges sorted so
// the layout is stable across runs.
const nsList = [...allGroups].sort();
const groupCtx = new Map(nsList.map((g) => [g, contextOf(byGroup.get(g)[0])]));
const nsEdges = [];
for (const [g, set] of gAdj) for (const h of set) nsEdges.push([g, h]);
nsEdges.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
const nsEdgeStyle = (a, b) => {
  if (groupCtx.get(a) !== groupCtx.get(b)) return 'color="#7b2ff7", penwidth=2.0, arrowsize=0.9';
  if (groupScc.id.get(a) === groupScc.id.get(b) && groupScc.size(a) > 1) return 'color="#ff8c00", penwidth=2.6, arrowsize=1.0';
  return 'color="#3b82f6", penwidth=1.4';
};
const nid = (g) => '"' + g + '"';
let ndot = 'digraph namespaces {\n';
ndot += '  graph [rankdir=LR, splines=true, overlap=false, nodesep=0.4, ranksep=1.8, fontname="Helvetica", fontsize=22, compound=true, bgcolor="white"];\n';
ndot += '  node [shape=box, style="filled,rounded", fontname="Helvetica-Bold", fontsize=18, margin="0.22,0.12", penwidth=0.8, color="#666666"];\n';
ndot += '  edge [arrowsize=0.9, penwidth=1.4];\n';
let nci = 0;
for (const [, ctxName] of CONTEXTS) {
  const gs = nsList.filter((g) => groupCtx.get(g) === ctxName);
  if (!gs.length) continue;
  ndot += `  subgraph "cluster_nsctx_${nci++}" {\n    label="${ctxName}"; style="filled,rounded"; fillcolor="${ctxColour(ctxName)}"; color="#888888"; penwidth=2.5; fontsize=30; fontname="Helvetica-Bold"; labelloc="t";\n`;
  for (const g of gs) ndot += `    ${nid(g)} [label="${g}", fillcolor="${colourOf(g)}"];\n`;
  ndot += '  }\n';
}
for (const [a, b] of nsEdges) ndot += `  ${nid(a)} -> ${nid(b)} [${nsEdgeStyle(a, b)}];\n`;
ndot += '  labelloc="b"; labeljust="l"; fontsize=16; fontname="Helvetica";\n';
ndot += '  label="edge colours:  orange = namespace cycle (not uni-directional)   purple = cross-context   blue = forward cross-namespace";\n';
ndot += '}\n';
const nsSvg = graphviz.layout(ndot, 'svg', 'dot');
const nsOut = config.output.graph;
writeFileSync(nsOut, nsSvg, 'utf8');

console.log(`\nwrote: ${nsOut} (${(nsSvg.length / 1024).toFixed(0)} KB)  — namespace level`);
