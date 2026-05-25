// Browser renderer for the GRAPH tab — an interactive Cytoscape dependency
// graph mirroring the matrix's hierarchy. Contexts are always-shown compound
// parents; namespaces are compounds whose file children stay hidden until you
// click the namespace ("intrinsic inspection"); edges are coloured by
// directionality. Layout is fcose with randomize:false (+ deterministic grid
// seeding) for a stable, reproducible result. Mounts lazily — Cytoscape needs a
// sized container, so the tab controller calls IGGraph.init() on first show.
//
// EDGE COLOURS:  purple = cross-context   orange = namespace cycle
//                blue = forward cross-namespace   grey = intra (file)   red = file cycle
(function () {
  const G = DATA.graph;
  const noop = { init() {}, fit() {}, relayout() {}, resize() {}, expandAll() {}, collapseAll() {} };
  if (!G || typeof cytoscape === 'undefined') { window.IGGraph = noop; return; }

  let cy = null;
  // every namespace starts collapsed (files hidden)
  const collapsed = new Set(G.nodes.filter((n) => n.kind === 'namespace').map((n) => n.id));

  function elements() {
    const els = [];
    for (const n of G.nodes) {
      const data = { id: n.id, label: n.label, colour: n.colour, full: n.title || n.label };
      if (n.parent) data.parent = n.parent;
      if (n.kind === 'namespace') { data.base = n.label; data.label = '▸ ' + n.label; }
      els.push({ group: 'nodes', data, classes: n.kind });
    }
    for (const e of G.nsEdges) els.push({ group: 'edges', data: { id: 'nse:' + e.source + '>' + e.target, source: e.source, target: e.target }, classes: 'nse ' + e.kind });
    for (const e of G.fileEdges) els.push({ group: 'edges', data: { id: 'fe:' + e.source + '>' + e.target, source: e.source, target: e.target, ns: e.ns }, classes: 'fe ' + e.kind });
    return els;
  }

  const STYLE = [
    { selector: 'node', style: { label: 'data(label)', 'font-size': 10, color: '#1f2937', 'text-wrap': 'none', 'min-zoomed-font-size': 5 } },
    { selector: 'node.context', style: { shape: 'round-rectangle', 'background-color': 'data(colour)', 'background-opacity': 0.35, 'border-width': 1.5, 'border-color': '#94a3b8', 'text-valign': 'top', 'text-halign': 'center', 'font-size': 14, 'font-weight': 'bold', color: '#334155', padding: '18px' } },
    { selector: 'node.namespace', style: { shape: 'round-rectangle', 'background-color': 'data(colour)', 'background-opacity': 0.9, 'border-width': 1, 'border-color': '#64748b', 'text-valign': 'center', 'text-halign': 'center', 'font-weight': 'bold', 'font-size': 11, padding: '10px' } },
    { selector: 'node.file', style: { shape: 'ellipse', width: 14, height: 14, 'background-color': 'data(colour)', 'border-width': 0.5, 'border-color': '#94a3b8', 'font-size': 8, 'text-valign': 'bottom', color: '#475569', 'text-margin-y': 2 } },
    { selector: 'edge', style: { 'curve-style': 'bezier', width: 1.2, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'line-color': '#9aa6b2', 'target-arrow-color': '#9aa6b2', opacity: 0.85 } },
    { selector: 'edge.crossCtx', style: { 'line-color': '#7b2ff7', 'target-arrow-color': '#7b2ff7', width: 2 } },
    { selector: 'edge.nsCycle', style: { 'line-color': '#ff8c00', 'target-arrow-color': '#ff8c00', width: 2.4 } },
    { selector: 'edge.forward', style: { 'line-color': '#3b82f6', 'target-arrow-color': '#3b82f6', width: 1.4 } },
    { selector: 'edge.intra', style: { 'line-color': '#b8c0cc', 'target-arrow-color': '#b8c0cc', width: 0.8, opacity: 0.6 } },
    { selector: 'edge.fileCycle', style: { 'line-color': '#dd0000', 'target-arrow-color': '#dd0000', width: 1.8 } },
    { selector: 'node:selected', style: { 'border-width': 2.5, 'border-color': '#2563eb' } },
  ];

  function applyCollapsed() {
    cy.batch(() => {
      cy.nodes('.file').forEach((n) => n.style('display', collapsed.has(n.data('parent')) ? 'none' : 'element'));
      cy.edges('.fe').forEach((e) => e.style('display', collapsed.has(e.data('ns')) ? 'none' : 'element'));
      cy.nodes('.namespace').forEach((n) => n.data('label', (collapsed.has(n.id()) ? '▸ ' : '▾ ') + n.data('base')));
    });
  }

  function relayout() {
    if (!cy) return;
    cy.elements(':visible').layout({ name: 'fcose', quality: 'proof', randomize: false, animate: true, animationDuration: 300, fit: true, padding: 30, nodeSeparation: 90, nodeDimensionsIncludeLabels: true, packComponents: true }).run();
  }

  function init(container) {
    if (cy) return;
    if (window.cytoscapeFcose) cytoscape.use(window.cytoscapeFcose);
    cy = cytoscape({ container, elements: elements(), style: STYLE, minZoom: 0.05, maxZoom: 4, boxSelectionEnabled: false });
    // deterministic seed: grid by element order → fcose (randomize:false) reproducible
    let i = 0; cy.nodes().forEach((n) => { n.position({ x: (i % 14) * 70, y: Math.floor(i / 14) * 70 }); i++; });
    cy.on('tap', 'node.namespace', (e) => { const id = e.target.id(); collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); applyCollapsed(); relayout(); });
    applyCollapsed();
    relayout();
  }

  window.IGGraph = {
    init,
    fit: () => cy && cy.fit(undefined, 30),
    relayout,
    resize: () => cy && cy.resize(),
    expandAll: () => { collapsed.clear(); applyCollapsed(); relayout(); },
    collapseAll: () => { G.nodes.forEach((n) => { if (n.kind === 'namespace') collapsed.add(n.id); }); applyCollapsed(); relayout(); },
  };
})();
