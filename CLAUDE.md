# inspector-gadget — codebase guide

Config-free codebase **dependency viewer**. Point it at a target project
(`--code-root`) and it emits one self-contained `codebase-dsm.html` *into that
root*, with two interactive tabs over the same dependency model — a Dependency
Structure **Matrix** and a Cytoscape dependency **Graph**. The emitted HTML has
no runtime and no build step; it opens straight from `file://`.

The tool is a single **.NET (`net10.0`) CLI** at the repo root. The two client
renderers + Cytoscape/fcose are embedded as resources and inlined verbatim into
the HTML. Code splits into an **ecosystem-agnostic `Core/`** (shared model +
viewer) and per-ecosystem analyzers in **`Analyzer/`** (`NodeAnalyzer` for
TypeScript source, `DotnetAnalyzer` for compiled .NET assemblies). Class-name
prefix signals the ecosystem; adding an ecosystem = add one analyzer that
produces the shared `Core.Model`.

## Build · run · verify
- **Prereqs:** .NET 10 SDK only. **No NuGet dependencies, no test project** — the
  whole thing is BCL-only (`System.Text.Json`, `System.Reflection.Metadata`,
  `System.Xml.Linq`). `dotnet build` is clean (0 warnings). Repo branch: `main`;
  license: MIT.
- **Debug:** `dotnet run -- <node|dotnet> --code-root <dir> [-h|--help]`
  (or the built exe `bin/Debug/net10.0/inspector-gadget.exe`).
- **Release (exe):** `dotnet publish -c Release -r <rid>` (`<rid>` = win-x64/
  win-arm64/linux-x64/linux-arm64/osx-x64/osx-arm64) → single-file, self-contained,
  compressed exe. RID is supplied only at publish time; plain build/run stays
  framework-dependent and needs no RID.
- **Release (NuGet tool):** `dotnet pack -c Release` → a **single portable,
  OS-agnostic** .NET tool package (framework-dependent net10.0; runs anywhere the
  runtime exists), id **`lib.inspector-gadget`**, command `inspector-gadget`
  (`PackAsTool` / `ToolCommandName` in the csproj). Install via `dotnet tool
  install --global lib.inspector-gadget`. The two release modes are independent
  and coexist. Version lives in the csproj (`<Version>`). **Do not add
  `<RuntimeIdentifiers>`** — it would make pack also emit per-RID self-contained
  tool packages; RIDs are passed on the CLI for the exe publish instead.
- **`--code-root` is required** (no default). The viewer is written to
  `<root>/codebase-dsm.html` and titled by the root dir's name.
- **`node`** scans a TS/Node project's **source** (`.ts/.tsx`, incl. `.d.ts`).
- **`dotnet`** scans a project's **built assemblies** (NDepend-style: assembly →
  namespace → type) — **the target must be built first** (`dotnet build`).
- **No config file** — every setting is a CLI arg + built-in defaults (`Cli.cs`).
- **Verifying viewer/HTML changes:** serve the target dir with a tiny static
  server + a throwaway `.claude/launch.json`, then use the preview tooling.
  Screenshots may time out (Cytoscape's render loop) — prefer DOM `eval` (check
  globals, node/edge counts, call `IMGraph` methods, read console errors). The
  console report (`Viewer.PrintReport`) is also a quick sanity check. Remove the
  throwaway server/launch.json afterwards.

## Pipeline (the whole data flow)
`Program.cs` validates args + dispatches → the chosen **analyzer** (`Analyzer/`)
walks the target and produces raw leaves + ctx/ns tags + edges + third-party refs
→ `Core.ModelBuilder.Assemble(...)` finalizes them into a complete `Core.Model`
(palette colours, three Tarjan SCCs, cluster lists, ns→files map) →
`Core.Viewer.Render(model, config)` computes the triangular order, builds the
payload DTO, inlines the clients + libs into `template.html`, writes the HTML,
and prints the directionality report. The analysis runs on a **256 MB-stack
worker thread** so deep recursion (Tarjan + reachability DFS) can't overflow.

## Files (all in the repo root)
Root = the generic CLI shell. `Core/` = ecosystem-agnostic. `Analyzer/` =
tech-stack-specific. `assets/` = embedded client resources.

- `Program.cs` — entry + ecosystem dispatch (validate `node|dotnet` +
  `--code-root`, `--help`); runs the analyzer + render on the large-stack worker.
- `Cli.cs` — generic CLI parsing (`Cli.Parse`: command / `--code-root` /
  `--help`; `--code-root=value` form too). No config file.

### `Core/` — ecosystem-agnostic
- `Config.cs` — run config + derivation (`Config.For`: abs root, `Title` = dir
  name, `OutputDsm` = `<root>/codebase-dsm.html`). Only `Exclude` is analyzer-fed.
- `Model.cs` — the shared dependency model: files, edges, per-level SCCs
  (`FileScc`/`GroupScc`/`CtxScc`), context/namespace lists + colour maps,
  file→ctx/ns maps, third-party packages + edges, type-only cross-context edges.
  The one definition of "the codebase"; knows nothing about any language. Also
  home to the `Edge(From,To)` / `TpRef(From,Package)` record structs (value
  equality → a `HashSet<Edge>` dedups directly, no string keys) and the
  `Model.NsSep` (`" · "`) constant used to qualify namespace labels.
- `ModelBuilder.cs` — `Assemble(...)`: the shared finalize step. Computes
  deterministic palette colours, the three Tarjan SCCs, cluster adjacency/lists,
  and the ns→files map. Both analyzers call it.
- `Scc.cs` — generic Tarjan SCC (deterministic: node + neighbour order preserved)
  + insertion-order-preserving sets (`OrderedIntSet`/`OrderedStringSet`) + `Seq`.
- `PosixPath.cs` — faithful port of Node `path.posix` normalize/join/dirname, so
  TS import resolution is identical regardless of the host OS separator.
- `Viewer.cs` — `Render(model, config)`: renders any `Model` → HTML + report.
  `TriOrder` (+ `ContextMajorOrder`) computes the dependency-first ("triangular")
  sibling order per level; `BuildPayload` orchestrates `BuildTree` (the
  context→namespace→file tree), `BuildMatrixData` (file-indexed edge list +
  reachability pairs), `BuildThirdParty`, and `BuildGraphData`, then `AssembleHtml`
  fills the template (single-pass `Fill`) with the inlined renderers + Cytoscape/
  fcose. Matrix *cells/colours/cycles* are aggregated **client-side** from the
  edge list, so the C# side is ordering + plumbing only. Defines the payload DTOs
  (`[JsonPropertyName]` = the JS object keys the clients read) and the `Wire`
  helper (`CtxId`/`NsId`/`FileId`). The **WIRE CONTRACT** comment at the top is the
  one place that enumerates the C#↔JS string protocol — read it before touching
  payload shape.

### `Analyzer/` — per-ecosystem (namespace `InspectorGadget.Analyzer`)
- `NodeAnalyzer.cs` — `Build(config)`: scan `.ts/.tsx`, resolve relative +
  tsconfig-`paths` imports (regex-based: `import/export … from`, side-effect, and
  dynamic `import()`/`require()`), collect value/type/third-party refs → hands raw
  bits to `ModelBuilder`. `DefaultExcludes` = node_modules/dist/build. tsconfig is
  parsed as JSONC (comments + trailing commas tolerated). Reads files as raw UTF-8
  bytes (no BOM strip) to match Node's `readFileSync`.
- `DotnetAnalyzer.cs` — `Build(config)`: NDepend-style analysis of the target's
  **built** assemblies via `System.Reflection.Metadata` (BCL-only). Discovers
  first-party assemblies from `.csproj` layout + `bin` output (skips `ref`/
  `refint`, picks newest by write time), then per type collects dependencies from
  structural metadata (base/interfaces/fields/properties/method sigs/attributes/
  generic constraints) **and** decoded method-body IL (`WalkIL` over token-bearing
  opcodes). context = assembly, namespace = C# namespace, leaf = type; every
  external assembly (incl. `System.*`/`Microsoft.*`) is a third-party ref.
  `DefaultExcludes` = bin/obj/node_modules. (No type-only/cross-context edges —
  that concept is node-only; passes an empty list.) Type identity + location use
  the local `TypeId(Assembly,FullName)` / `TypeLoc(ReaderIdx,Handle)` records.

### `assets/` — embedded resources (inlined verbatim into the HTML)
- `dsm.client.js` — **Matrix** renderer (vanilla DOM; reads global `DATA`).
- `graph.client.js` — **Graph** renderer (Cytoscape; exposes `window.IMGraph`
  with `init/fit/relayout/resize/expandAll/collapseAll`).
- `cytoscape.min.js`, `layout-base.js`, `cose-base.js`, `cytoscape-fcose.js` —
  the graph libraries (joined with `\n;\n` and inlined).
- `template.css`, `template.html` — page CSS + HTML skeleton. `${...}`
  placeholders (`${title} ${CSS} ${LIBS} ${JSON.stringify(payload)} ${CLIENT}
  ${GRAPH_CLIENT}`) are filled by `Viewer.Fill`.

## Invariants — preserve these when editing
- **Determinism.** Output (HTML + console report) must diff cleanly across runs.
  Sort node/edge/context lists. JS default sort / `<` ↔ `StringComparer.Ordinal`;
  JS `localeCompare` (alpha order + triangular order) ↔
  `StringComparer.InvariantCulture` with stable `OrderBy`. Keep `<Deterministic>`
  on and **`<InvariantGlobalization>` OFF** — ICU collation is required for the
  triangular order to mirror `localeCompare`.
- **The C#↔JS wire contract is unenforced.** `Viewer.cs` produces node-id strings
  (`Wire.CtxId`/`NsId`/`FileId`) + the `[JsonPropertyName]` payload keys that
  `dsm.client.js` and `graph.client.js` consume by hand — no compile-time link.
  Change one side and you MUST change the other. The `WIRE CONTRACT` comments
  (top of `Viewer.cs` and each JS client) enumerate the shared keys/prefixes.
- **BCL-only.** No external NuGet, so the published single exe is fully
  self-contained (no .NET install, no node_modules, no loose files).
- **`assets/` are hand-edited static copies**, not generated — edit in place. They
  are inlined into the HTML at render time, which is what makes the exe runtime-
  free.
- **`.gitattributes` forces LF** on all checkouts so the embedded assets (and the
  emitted HTML) stay byte-stable across platforms.

## Model conventions
Everything is derived from the target's layout.

**node ecosystem:**
- **Context** = each top-level dir under `--code-root` (minus `exclude` names +
  dot-dirs); a context with no `.ts/.tsx` never appears.
- **Source root** per context = its `src/` if present, else the dir itself.
- **Namespace** = first path segment below the source root; root files →
  `(root)`. Context-qualified, e.g. `TOW.EDB · pipeline`.
- **Cross-context resolution** = each context's `tsconfig*.json`
  `compilerOptions.paths` (+ `baseUrl`) is auto-read to resolve non-relative
  imports that target sibling contexts → cross-context first-party edges. No
  alias config — each tsconfig is the only source.
- **Edges:** value imports → `edges` (feed matrix + SCC + graph). Whole-statement
  `import type` / `export type` are excluded from `edges` (they erase at build).
  **Exception:** type-only *cross-context* imports go to `typeXctxEdges` —
  graph-only, kept out of SCC so they can't create false cycles (lets contract
  contexts show as depended-upon).
- **Third-party** = non-relative imports resolving to neither a relative file nor
  a tsconfig alias, excluding `node:` builtins. One node per package root
  (`react`, `@scope/name`); type-only counts. Matrix-only (purple, row axis);
  absent from the graph; pure sinks (never in cycles).

**dotnet ecosystem:** context = assembly, namespace = C# namespace
(context-qualified `{asm} · {ns}`, root types → `(root)`), leaf = type. Edges =
type→type. Third-party = every referenced external assembly. No type-only or
cross-context edge concept.

**Both:** context/namespace colours are assigned from fixed pastel palettes by
sorted name (`ModelBuilder`), so colours are deterministic.

## Matrix (`assets/dsm.client.js`)
- Hierarchical DSM: context → namespace → file via expand/collapse. Cell `(r,c)`
  = "row depends on col". Triangular (dependency-first) or alphabetical order;
  Direct or `+ Indirect` (transitive reachability) mode.
- Third-party rows pinned at the bottom (purple `tpcell`), toggleable
  (`3rd-party / hide`); first-party cells white. **Columns are first-party only**
  (NDepend style) — third-party never a column.
- Parent cells aggregate descendants' file imports; ancestor/descendant +
  diagonal render as "nesting". Click a cell to list the imports behind it.
- "Collapse all" stops at the namespace level (contexts stay expanded).

## Graph (`assets/graph.client.js`)
- Cytoscape compound graph: contexts = always-shown parents, namespaces =
  collapsible compounds, files = leaves. Click a namespace to reveal/hide files;
  mounts lazily on first tab show (`IMGraph.init`).
- Each file→file edge is routed to the **deepest visible** node per endpoint
  (file when its namespace is expanded, else the namespace), self-loops dropped,
  duplicates aggregated. Coloured by directionality: **purple** cross-context,
  **orange** ns-cycle, **blue** forward cross-namespace, **grey** intra (file),
  **red** file-cycle.
- Layout: fcose `randomize:false` + deterministic grid seed (position by element
  order) → reproducible and stable across expand/collapse.
