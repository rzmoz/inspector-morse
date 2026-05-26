# inspector.gadget — codebase guide

Config-driven codebase **dependency viewer**. Reads an `inspector.gadget.json`
in a *target* project and emits one self-contained `codebase-dsm.html` with two
interactive tabs — a Dependency Structure **Matrix** and a Cytoscape dependency
**Graph**. No build step; the HTML opens straight from `file://`. Pure ESM
(`.mjs`); the analysis half uses only Node built-ins.

## Run
- `node bin/cli.mjs [graph|dsm|all] [--config <path>]` — all three commands emit
  the same combined viewer (names kept for familiarity).
- `npm run all | dsm | graph`.
- Config resolution: `--config`, else `$IG_CONFIG_PATH`, else nearest
  `inspector.gadget.json` walking up from cwd. Its directory is the project root.

## Files
- `bin/cli.mjs` — CLI dispatch; imports `src/dsm.mjs` (self-runs on import).
- `src/config.mjs` — loads the settings file. Keys (all optional): `title`,
  `exclude`, `includeDts`, `output.dir`, `output.dsm`. No `srcRoots`, `contexts`,
  `namespaces`, or `aliases` — those are all derived (see below).
- `src/codebase-model.mjs` — `buildModel(config)`: the whole analysis. Scans
  `.ts/.tsx`, resolves imports, clusters, runs Tarjan SCC at file/namespace/
  context levels. Shared by both tabs — one definition of "the codebase".
- `src/dsm.mjs` — assembles the combined HTML. Computes the dependency-first
  ("triangular") sibling order per level (`triOrder`), then ships a
  context→namespace→file tree + the raw file-indexed edge list (matrix) and the
  graph payload; the matrix *cells/colours/cycles* are aggregated client-side
  from those edges, so the server side stays ordering + plumbing only. Inlines
  `dsm.client.js`, `graph.client.js`, and Cytoscape + fcose from `node_modules`.
  Writes `output.dsm`.
- `src/dsm.client.js` — **Matrix** renderer (vanilla DOM).
- `src/graph.client.js` — **Graph** renderer (Cytoscape).

## Model conventions (everything derived from the target's layout)
- **Context** = each top-level dir under the config file (minus `exclude` names
  and dot-dirs); a context with no `.ts/.tsx` never appears.
- **Source root** per context = its `src/` if present, else the dir itself.
- **Namespace** = first path segment below the source root; root files → `(root)`.
  Names are context-qualified, e.g. `TOW.EDB · pipeline`.
- **Cross-context resolution** = each context's `tsconfig*.json`
  `compilerOptions.paths` is auto-read (string-aware jsonc parse) to resolve
  non-relative imports that target sibling contexts → cross-context first-party
  edges. No alias config lives in `inspector.gadget.json`.
- **Edges**: value imports → `edges` (feed matrix + SCC + graph). Whole-statement
  `import type` / `export type` excluded from `edges`. **Exception**: type-only
  *cross-context* imports go to `typeXctxEdges` — graph-only, kept out of SCC so
  they can't create false cycles (lets contract contexts show as depended-upon).
- **Third-party** = non-relative imports resolving to neither a relative file nor
  a tsconfig path-alias, excluding `node:` builtins. One node per package root;
  type-only counts. Matrix only (purple, row axis); absent from the graph.
- Output is **deterministic** — sort node/edge/context lists so the emitted HTML
  and console report diff cleanly across runs. Preserve this when editing.

## Matrix (`dsm.client.js`)
- Hierarchical DSM: context → namespace → file via expand/collapse. Cell `(r,c)`
  means "row depends on col". Triangular (dependency-first) or alphabetical order.
- Third-party rows pinned at the bottom (purple cells, `tpcell`); first-party
  cells white — two distinguishable regions. Columns are first-party only.
- Column headers: rotated vertical entry names + index. No row-header colour
  swatch. "Collapse all" stops at the namespace level (contexts stay expanded).

## Graph (`graph.client.js`)
- Cytoscape compound graph: contexts = always-shown parents, namespaces =
  collapsible compounds, files = leaves. Click a namespace to reveal/hide files.
- Edges routed to the **deepest visible** node per endpoint (file when its
  namespace is expanded, else the namespace) and aggregated; coloured by
  directionality: purple cross-context, orange ns-cycle, blue forward, grey
  intra, red file-cycle.
- Layout: fcose `randomize:false` + deterministic grid seed → reproducible and
  stable across expand/collapse.

## Working notes
- Verify visual / HTML changes in a real browser: serve the target dir with a
  tiny static server + a `.claude/launch.json`, then use the preview tooling.
  Screenshots may time out (Cytoscape's render loop) — verify via DOM `eval`
  instead (check globals, node/edge counts, run `IGGraph` methods, read console
  errors). Remove the throwaway server/launch.json afterwards.
- The shared model must stay framework-free (Node built-ins only) so both
  renderers and the CLI keep working without a build step.
