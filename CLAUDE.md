# inspector-gadget — codebase guide

Config-free codebase **dependency viewer**. Scans a target project (passed via
`--code-root`) and emits one self-contained `codebase-dsm.html` (into that root)
with two interactive tabs — a Dependency Structure **Matrix** and a Cytoscape
dependency **Graph**. The emitted HTML has no runtime and no build step; it opens
straight from `file://`. The tool itself is a single **.NET** (net10.0) CLI living
at the repository root; the two client renderers and Cytoscape + fcose are embedded as
resources and inlined verbatim into the HTML. The code splits cleanly into an
**ecosystem-agnostic `Core/`** (the shared model + the viewer) and per-ecosystem
analyzers in **`Analyzer/`** (`NodeAnalyzer` for TypeScript source, `DotnetAnalyzer`
for compiled .NET assemblies) — class names signal which is which; each ecosystem
just adds an analyzer that produces the shared model.

## Run
- Debug: `dotnet run -- <node|dotnet> --code-root <dir> [-h|--help]`
  (or the built exe `bin/Debug/net10.0/inspector-gadget.exe`).
- `node` scans a TS/Node project's source; `dotnet` scans a project's **built**
  assemblies (NDepend-style: assembly → namespace → type, via System.Reflection.Metadata).
  `--code-root` is required (no default); the viewer is written into it and titled by its dir name.
- No config file — all settings are CLI args + built-in defaults (`Cli.cs`).
- Release: `dotnet publish -c Release -r <rid>` → single-file, self-contained,
  OS-agnostic exe (`<rid>` = win-x64/linux-x64/osx-arm64/…). Not packed/installed.

## Files (all in the repo root)
**`Core/`** is ecosystem-agnostic (works for any codebase model); **`Analyzer/`**
holds the tech-stack-specific analyzers. The root holds the generic CLI shell.

- `Program.cs` — entry + ecosystem dispatch: validates `node|dotnet` + `--code-root`,
  handles `--help`, then runs the matching ecosystem analyzer and renders.
  The analysis runs on a large-stack worker thread.
- `Cli.cs` — generic CLI parsing (`Cli.Parse`: command / `--code-root` / `--help`);
  no config file.

### `Core/` — ecosystem-agnostic (any codebase model)
- `Config.cs` — run config + generic derivation (`Config.For`: abs root, `title` =
  dir name, output = `<root>/codebase-dsm.html`). Only `Exclude` is ecosystem-supplied.
- `Model.cs` — the shared dependency model: contexts/namespaces/files, import
  edges, per-level SCCs, third-party refs. The one definition of "the codebase"
  that every analyzer produces and the viewer consumes — knows nothing about TS.
- `ModelBuilder.cs` — `ModelBuilder.Assemble(...)`: the shared finalize step. An
  analyzer supplies raw leaf nodes + tags + edges + third-party refs; this computes
  palette colours, the three Tarjan SCCs, cluster lists and the namespace→files map
  → a complete `Model`. Both analyzers call it.
- `Scc.cs` — generic Tarjan SCC + insertion-order-preserving sets + `Seq`.
- `PosixPath.cs` — faithful `path.posix` normalize/join/dirname, so import
  resolution is identical regardless of the host OS separator.
- `Viewer.cs` — `Viewer.Render(model, config)`: renders any `Model` into the HTML.
  Computes the dependency-first ("triangular") sibling order per level (`TriOrder`),
  ships a context→namespace→file tree + the raw file-indexed edge list (matrix) and
  the graph payload; the matrix *cells/colours/cycles* are aggregated client-side
  from those edges, so the C# side stays ordering + plumbing only. Fills the HTML
  template with the inlined renderers + Cytoscape + fcose, writes the viewer, prints
  the report. Also defines the payload DTOs.

### `Analyzer/` — the per-ecosystem analyzers (namespace `InspectorGadget.Analyzer`)
- `NodeAnalyzer.cs` — `NodeAnalyzer.Build(config)`: scans `.ts/.tsx`, resolves
  relative + tsconfig-path imports, collects value/type/third-party refs, then hands
  the raw bits to `ModelBuilder`. `DefaultExcludes` = node_modules/dist/build.
- `DotnetAnalyzer.cs` — `DotnetAnalyzer.Build(config)`: NDepend-style analysis of the
  target's **built** assemblies via `System.Reflection.Metadata` (BCL-only). Discovers
  first-party assemblies from the `.csproj` layout + `bin` output, then per type
  collects dependencies from structural metadata **and** decoded method-body IL.
  context = assembly, namespace = C# namespace, leaf = type; every external assembly
  (incl. `System.*`) is a third-party ref. The target must be built first. Produces a
  `Core.Model` via `ModelBuilder`. `DefaultExcludes` = bin/obj/node_modules.

### `assets/` — embedded resources (generic; inlined verbatim into the HTML)
- `dsm.client.js` — **Matrix** renderer (vanilla DOM).
- `graph.client.js` — **Graph** renderer (Cytoscape).
- `cytoscape.min.js`, `layout-base.js`, `cose-base.js`, `cytoscape-fcose.js` —
  the graph libraries.
- `template.css`, `template.html` — page CSS + HTML skeleton (`${...}` placeholders
  filled by `Viewer.cs`).

## Model conventions (everything derived from the target's layout)
- **Context** = each top-level dir under `--code-root` (minus `exclude` names and
  dot-dirs); a context with no `.ts/.tsx` never appears.
- **Source root** per context = its `src/` if present, else the dir itself.
- **Namespace** = first path segment below the source root; root files → `(root)`.
  Names are context-qualified, e.g. `TOW.EDB · pipeline`.
- **Scan scope** = all `.ts/.tsx` including `.d.ts` (node always scans type
  declarations); only `exclude` names + dot-dirs are skipped.
- **Cross-context resolution** = each context's `tsconfig*.json`
  `compilerOptions.paths` is auto-read (System.Text.Json, comments + trailing
  commas tolerated) to resolve non-relative imports that target sibling contexts
  → cross-context first-party edges. There is no alias config — each context's
  tsconfig is the only source.
- **Edges**: value imports → `edges` (feed matrix + SCC + graph). Whole-statement
  `import type` / `export type` excluded from `edges`. **Exception**: type-only
  *cross-context* imports go to `typeXctxEdges` — graph-only, kept out of SCC so
  they can't create false cycles (lets contract contexts show as depended-upon).
- **Third-party** = non-relative imports resolving to neither a relative file nor
  a tsconfig path-alias, excluding `node:` builtins. One node per package root;
  type-only counts. Matrix only (purple, row axis); absent from the graph.
- Output is **deterministic** — sort node/edge/context lists so the emitted HTML
  and console report diff cleanly across runs. Preserve this when editing.

## Matrix (`assets/dsm.client.js`)
- Hierarchical DSM: context → namespace → file via expand/collapse. Cell `(r,c)`
  means "row depends on col". Triangular (dependency-first) or alphabetical order.
- Third-party rows pinned at the bottom (purple cells, `tpcell`); first-party
  cells white — two distinguishable regions. Columns are first-party only.
- Column headers: rotated vertical entry names + index. No row-header colour
  swatch. "Collapse all" stops at the namespace level (contexts stay expanded).

## Graph (`assets/graph.client.js`)
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
  instead (check globals, node/edge counts, run `IMGraph` methods, read console
  errors). Remove the throwaway server/launch.json afterwards.
- Determinism mirrors the conventions exactly: JS default sort / `<` →
  `StringComparer.Ordinal`; `localeCompare` (triangular order) →
  `StringComparer.InvariantCulture` with stable `OrderBy`. Keep sorts stable, and
  keep `InvariantGlobalization` off (ICU is required for the collation).
- `assets/` holds static copies: the two renderers, the Cytoscape/fcose libs, and
  the CSS/HTML template. They are not generated — edit them in place. The analysis
  stays BCL-only (System.Text.Json; no external NuGet) so the published single
  exe is fully self-contained (no .NET install, no node_modules, no loose files).
