// Browser renderer for the hierarchical Dependency Structure Matrix. Plain DOM,
// no framework. Inlined verbatim into codebase-dsm.html by dsm.mjs; reads the
// global `DATA` blob: a context → namespace → file tree, the file-indexed import
// edges, file-level cycle (SCC) + reachability info, and the context colour key.
//
// One matrix covers all three levels via expand/collapse (NDepend-style nested
// DSM): every visible tree node is a square row+column; a parent's cell is the
// aggregate of its descendants' file imports; ancestor/descendant + diagonal
// cells render as "nesting" so the nested diagonal blocks are visible.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const T = DATA, N = T.nodes;
  const state = { order: 'tri', mode: 'direct' };
  const expanded = {};
  for (const id in N) { const k = N[id].kind; if (k === 'context') expanded[id] = true; else if (k === 'namespace') expanded[id] = false; }

  const grid = $('#grid'), help = $('#help'), panel = $('#panel'), pbody = $('#pbody'), meta = $('#meta'), ctxlegend = $('#ctxlegend');

  // bounded-context colour key
  const CC = {}; for (const c of T.contexts) CC[c.name] = c.colour;
  ctxlegend.innerHTML = '<b>bounded contexts:</b>' + T.contexts.map((c) => `<span><i style="background:${c.colour}"></i>${esc(c.name)}</span>`).join('');

  // per-node subtree files + cycle-comp set (computed once)
  const subFiles = {}; const nodeCyc = {};
  const cycComps = new Set(T.cycleComps);
  function buildSub(id) { const n = N[id]; if (n.kind === 'file') subFiles[id] = [n.fi]; else { let a = []; for (const c of n.children) { buildSub(c); a = a.concat(subFiles[c]); } subFiles[id] = a; } const s = new Set(); for (const fi of subFiles[id]) { const comp = T.fileComp[fi]; if (cycComps.has(comp)) s.add(comp); } nodeCyc[id] = s; }
  for (const r of T.roots) buildSub(r);
  const shareCycle = (a, b) => { const A = nodeCyc[a], B = nodeCyc[b]; if (!A.size || !B.size) return false; for (const x of A) if (B.has(x)) return true; return false; };

  const isAnc = (a, b) => { let x = N[b].parent; while (x) { if (x === a) return true; x = N[x].parent; } return false; };
  const nsKey = (id) => { const n = N[id]; return n.kind === 'file' ? n.parent : n.kind === 'namespace' ? id : 'C' + id; };

  // children / roots in the active sibling order
  const ordered = (arr) => state.order === 'alpha' ? arr.slice().sort((p, q) => N[p].label.localeCompare(N[q].label)) : arr;
  const kids = (id) => ordered(N[id].children);

  // visible ancestors of a file (the nodes that currently carry its weight)
  const visAnc = (fi) => { const fid = 'f:' + fi, ns = N[fid].parent, ctx = N[ns].parent; const out = [ctx]; if (expanded[ctx]) { out.push(ns); if (expanded[ns]) out.push(fid); } return out; };

  let cur = null; // {vis, cell, indSet}
  const HL = { colCells: [], rowEls: [], colHs: [], rowHs: [] };
  let curR = -1, curC = -1;

  function syncButtons() {
    document.querySelectorAll('[data-ctl] button').forEach((b) => b.classList.toggle('on', state[b.parentElement.dataset.ctl] === b.dataset.val));
  }

  function render() {
    // visible nodes = pre-order over the expanded tree
    const vis = [];
    const recf = (id) => { vis.push(id); if (N[id].kind !== 'file' && expanded[id]) for (const c of kids(id)) recf(c); };
    for (const r of ordered(T.roots)) recf(r);
    const n = vis.length;

    // aggregate cells from file edges (parent rows sum their descendants)
    const cell = new Map();
    for (const [a, b] of T.edges) {
      const ra = visAnc(a), ca = visAnc(b);
      for (const r of ra) for (const c of ca) {
        if (r === c || isAnc(r, c) || isAnc(c, r)) continue;
        const k = r + '>' + c; let o = cell.get(k);
        if (!o) { o = { w: 0, edges: [] }; cell.set(k, o); }
        o.w++; o.edges.push(T.filePaths[a] + '  →  ' + T.filePaths[b]);
      }
    }
    const indSet = new Set();
    if (state.mode === 'indirect') {
      for (const [a, b] of T.reachPairs) {
        const ra = visAnc(a), ca = visAnc(b);
        for (const r of ra) for (const c of ca) {
          if (r === c || isAnc(r, c) || isAnc(c, r)) continue;
          const k = r + '>' + c; if (!cell.has(k)) indSet.add(k);
        }
      }
    }
    cur = { vis, cell, indSet };

    // context / namespace separators (tree order keeps each group contiguous)
    const rowB = vis.map((id, k) => k === 0 ? '' : (N[id].ctx !== N[vis[k - 1]].ctx ? 'ctop' : (nsKey(id) !== nsKey(vis[k - 1]) ? 'nstop' : '')));
    const colB = vis.map((id, k) => k === 0 ? '' : (N[id].ctx !== N[vis[k - 1]].ctx ? 'cleft' : (nsKey(id) !== nsKey(vis[k - 1]) ? 'nsleft' : '')));

    const nc = T.cycleComps.length;
    meta.innerHTML = `<b>Hierarchical DSM</b> — ${n} rows shown · ${T.fileCount} files · ${T.edgeCount} imports · ${nc} file cycle${nc === 1 ? '' : 's'}`;

    let h = '<table class="dsm"><thead><tr><th class="corner">↓ row depends on col →</th>';
    for (let c = 0; c < n; c++) h += `<th class="colh${colB[c] ? ' ' + colB[c] : ''}" data-c="${c}" title="${esc(N[vis[c]].title)}" style="background:${CC[N[vis[c]].ctx] || ''}">${c + 1}</th>`;
    h += '</tr></thead><tbody>';
    for (let r = 0; r < n; r++) {
      const R = vis[r], rn = N[R];
      const tog = rn.kind === 'file' ? '<span class="tog sp">•</span>' : `<span class="tog">${expanded[R] ? '▾' : '▸'}</span>`;
      const pad = 8 + rn.depth * 15;
      h += `<tr data-r="${r}"><th class="rowh k-${rn.kind}${rowB[r] ? ' ' + rowB[r] : ''}" data-id="${R}" data-r="${r}" title="${esc(rn.title)}" style="background:${CC[rn.ctx] || ''};padding-left:${pad}px">${tog}<i style="background:${rn.colour}"></i><span class="num">${r + 1}</span>${esc(rn.label)}</th>`;
      for (let c = 0; c < n; c++) {
        const C = vis[c];
        const bnd = (rowB[r] ? ' ' + rowB[r] : '') + (colB[c] ? ' ' + colB[c] : '');
        if (R === C) { h += `<td class="diag${bnd}" data-r="${r}" data-c="${c}" style="background:${rn.colour}"></td>`; continue; }
        if (isAnc(R, C) || isAnc(C, R)) { h += `<td class="nest${bnd}" data-r="${r}" data-c="${c}"></td>`; continue; }
        const d = cell.get(R + '>' + C), u = cell.get(C + '>' + R);
        let cls = '', txt = '';
        if (d && u) { cls = 'mutual'; txt = d.w; }
        else if (d) { cls = 'dep'; txt = d.w; }
        else if (u) { cls = 'used'; txt = u.w; }
        else if (state.mode === 'indirect') { if (indSet.has(R + '>' + C)) cls = 'dep ind'; else if (indSet.has(C + '>' + R)) cls = 'used ind'; }
        if ((d || u) && shareCycle(R, C)) cls += ' cyc';
        h += `<td class="${cls}${bnd}" data-r="${r}" data-c="${c}">${txt}</td>`;
      }
      h += '</tr>';
    }
    h += '</tbody></table>';
    grid.innerHTML = h;
    indexCells(n);
    syncButtons();
    closePanel();
    curR = curC = -1;
    help.innerHTML = 'Click a context/namespace row to expand or collapse it. Hover a cell to read the dependency; click a cell to list the imports behind it.';
  }

  function indexCells(n) {
    const t = grid.querySelector('table');
    HL.rowEls = Array.from(t.tBodies[0].rows);
    HL.colCells = Array.from({ length: n }, () => []);
    HL.colHs = []; HL.rowHs = [];
    t.querySelectorAll('.colh').forEach((th) => { HL.colHs[+th.dataset.c] = th; });
    HL.rowEls.forEach((tr) => { HL.rowHs[+tr.dataset.r] = tr.querySelector('.rowh'); tr.querySelectorAll('td').forEach((td) => HL.colCells[+td.dataset.c].push(td)); });
  }

  // ---- crosshair highlight ----
  function clearHL() {
    if (curR >= 0) { HL.rowEls[curR]?.classList.remove('hl'); HL.rowHs[curR]?.classList.remove('hlh'); }
    if (curC >= 0) { HL.colHs[curC]?.classList.remove('hlh'); HL.colCells[curC]?.forEach((td) => td.classList.remove('hlc')); }
    curR = curC = -1;
  }
  function setHL(r, c) {
    if (r === curR && c === curC) return;
    clearHL();
    if (r >= 0) { HL.rowEls[r]?.classList.add('hl'); HL.rowHs[r]?.classList.add('hlh'); }
    if (c >= 0) { HL.colHs[c]?.classList.add('hlh'); HL.colCells[c]?.forEach((td) => td.classList.add('hlc')); }
    curR = r; curC = c;
  }
  grid.addEventListener('mouseover', (e) => {
    const el = e.target.closest('td,th'); if (!el || el.classList.contains('corner')) return;
    const r = el.dataset.r !== undefined ? +el.dataset.r : -1;
    const c = el.dataset.c !== undefined ? +el.dataset.c : -1;
    setHL(r, c); describe(r, c);
  });
  grid.addEventListener('mouseleave', clearHL);

  function rel(r, c) { // returns {R,C,rn,cn,d,u,containment}
    const R = cur.vis[r], C = cur.vis[c];
    if (R === C || isAnc(R, C) || isAnc(C, R)) return { R, C, rn: N[R], cn: N[C], containment: true };
    return { R, C, rn: N[R], cn: N[C], d: cur.cell.get(R + '>' + C), u: cur.cell.get(C + '>' + R) };
  }
  function describe(r, c) {
    if (r >= 0 && c >= 0 && r !== c) {
      const x = rel(r, c);
      let s = `<b>${r + 1}.</b> ${esc(x.rn.label)} &nbsp;·&nbsp; <b>${c + 1}.</b> ${esc(x.cn.label)} — `;
      if (x.containment) s += 'nesting (one contains the other)';
      else if (x.d && x.u) s += `<b class="t-blk">mutual / cycle</b> · ${x.d.w} → and ${x.u.w} ← imports`;
      else if (x.d) s += `<b class="t-blue">${esc(x.rn.label)} depends on ${esc(x.cn.label)}</b> · ${x.d.w} import${x.d.w === 1 ? '' : 's'}`;
      else if (x.u) s += `<b class="t-green">${esc(x.cn.label)} depends on ${esc(x.rn.label)}</b> · ${x.u.w} import${x.u.w === 1 ? '' : 's'}`;
      else if (cur.indSet.has(x.R + '>' + x.C)) s += `<span class="t-blue">indirect — reaches transitively</span>`;
      else if (cur.indSet.has(x.C + '>' + x.R)) s += `<span class="t-green">indirect — reached transitively</span>`;
      else s += 'no dependency';
      help.innerHTML = s;
    } else if (r >= 0) help.innerHTML = `row <b>${r + 1}.</b> ${esc(N[cur.vis[r]].title)} — read across → for what it depends on`;
    else if (c >= 0) help.innerHTML = `col <b>${c + 1}.</b> ${esc(N[cur.vis[c]].title)} — read down ↓ for what depends on it`;
  }

  // ---- click: toggle a parent row, or open a cell's import list ----
  grid.addEventListener('click', (e) => {
    const th = e.target.closest('th.rowh');
    if (th) { const id = th.dataset.id; if (N[id].kind !== 'file') { expanded[id] = !expanded[id]; render(); } return; }
    const td = e.target.closest('td');
    if (!td || td.classList.contains('diag') || td.classList.contains('nest') || td.dataset.c === undefined) return;
    openPanel(+td.dataset.r, +td.dataset.c);
  });
  const edgeList = (cell, klass) => cell ? cell.edges.map((s) => `<div class="e ${klass}">${esc(s)}</div>`).join('') : '';
  function openPanel(r, c) {
    const x = rel(r, c); if (x.containment) return;
    let h = `<div class="phead"><button class="pclose" title="close">×</button><b>${r + 1}.</b> ${esc(x.rn.label)} &nbsp;↔&nbsp; <b>${c + 1}.</b> ${esc(x.cn.label)}</div>`;
    if (x.d) h += `<div class="psec"><h4 class="t-blue">${esc(x.rn.label)} → ${esc(x.cn.label)} · ${x.d.w}</h4>${edgeList(x.d, 'blue')}</div>`;
    if (x.u) h += `<div class="psec"><h4 class="t-green">${esc(x.cn.label)} → ${esc(x.rn.label)} · ${x.u.w}</h4>${edgeList(x.u, 'green')}</div>`;
    if (!x.d && !x.u) h += '<div class="psec">No direct imports between these two (try the indirect toggle, or expand them).</div>';
    pbody.innerHTML = h;
    panel.classList.remove('empty');
    pbody.querySelector('.pclose').onclick = closePanel;
  }
  function closePanel() { panel.classList.add('empty'); pbody.innerHTML = ''; }

  // ---- controls ----
  document.querySelectorAll('[data-ctl] button').forEach((b) => b.addEventListener('click', () => { state[b.parentElement.dataset.ctl] = b.dataset.val; render(); }));
  document.querySelectorAll('#xpand button').forEach((b) => b.addEventListener('click', () => {
    const all = b.dataset.act === 'expand';
    for (const id in N) { const k = N[id].kind; if (k === 'context') expanded[id] = all; else if (k === 'namespace') expanded[id] = all; }
    render();
  }));

  render();
})();
