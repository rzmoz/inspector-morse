# inspector-morse

Tooling for code inspection on various tech-stacks — relevant in the AI era where
manual coding is almost absent but understanding of code is ever as relevant.

**Codebase dependency** tooling. Point it at a project root and it emits a single
self-contained **`codebase-dsm.html`** (no runtime; opens from `file://`) into
that root, with two tabs:

- **Matrix** — an interactive NDepend-style **Dependency Structure Matrix**,
  switchable across file / namespace / context via expand-collapse, third-party
  references on the row axis.
- **Graph** — an interactive **Cytoscape** dependency graph: bounded contexts
  and namespaces always shown, click a namespace to reveal/hide its files, edges
  coloured by directionality health (cycle / cross-context / forward / intra).

Both tabs share one model: a `.ts`/`.tsx` import scan → file dependency graph →
namespace/context clustering → Tarjan **SCC** at all three levels. Whole-statement
`import type` / `export type` edges are excluded from the file graph (they erase
at build, so they are not runtime dependencies and must not form cycles) — but
type-only imports of *external* packages still count as third-party references
(see below).

The tool is a single **.NET** (net10.0) CLI; the browser renderers and Cytoscape
+ fcose are embedded into the executable and inlined into the emitted HTML.

## Usage

There is **no config file** — every setting comes from CLI args and built-in
defaults.

```
inspector-morse <node|dotnet> --code-root <dir> [-h|--help]
```

| Arg | Meaning |
|---|---|
| `<node\|dotnet>` | target ecosystem (required). `node` scans a TypeScript/Node project; `dotnet` is **not implemented** and errors. |
| `--code-root <dir>` | project root to scan (**required**, no default). |
| `-h`, `--help` | print usage and exit. |

The output `codebase-dsm.html` is always written into the `--code-root` directory,
and the page title is that directory's name.

Example:

```
inspector-morse node --code-root C:\Projects\battlebuddy
```

### Build & run

Requires the .NET 10 SDK; the project lives in `dotnet/`.

```
# local debug
dotnet run --project dotnet -- node --code-root <dir>

# release: single-file, self-contained, OS-agnostic — pick a runtime identifier
dotnet publish dotnet -c Release -r win-x64     # or linux-x64, osx-x64, osx-arm64, …
```

A self-contained publish bundles the .NET runtime plus all assets, so the
resulting single executable runs with no .NET install, no `node_modules`, and no
other files alongside it.

### The `node` ecosystem

`node` walks `--code-root`, skipping the directory names `node_modules`, `dist` and
`build` (and dot-dirs). All `.ts`/`.tsx` are scanned, **including `.d.ts` type
declarations** — type contracts always participate.

`dotnet` is reserved for a future .NET analyzer; today it exits with a
"not implemented" error.

### Levels are derived from the layout

- **Context** — each immediate child directory of `--code-root`, skipping the
  excluded names and dot-dirs. A context with no scannable `.ts`/`.tsx` simply
  never appears.
- **Source root** (per context) — the context's `src/` subdir if it exists, else
  the context dir itself (e.g. a `.d.ts`-only contract package). Only each
  context's source root is walked, so sibling `tests/`, `__tests__/` and loose
  config files stay out of the graph.
- **Namespace** — the first path segment beneath the source root; files sitting
  directly in the source root fall into `(root)`. Names are context-qualified
  for uniqueness, e.g. `A · core`, `A · (root)`.

Context and namespace **colours** are assigned automatically from fixed pastel
palettes (by sorted name), so output is deterministic across runs.

### Cross-context resolution (tsconfig `paths`)

Non-relative imports are first matched against the importing context's tsconfig
`paths` — each context's own `tsconfig*.json` `compilerOptions.paths` is read
automatically. A path-alias that targets another context (e.g.
`@peek-view` → `../TOW.BattleBuddy/src/peek-view`) resolves to that context's
files, producing a **cross-context first-party edge**. Type-only cross-context
imports (e.g. a `@tow/abstractions` contract) don't enter the file graph / cycle
analysis, but are surfaced to the **Graph** tab so contract contexts still show
as depended-upon.

### Third-party references

Non-relative imports that resolve to neither a relative file nor a tsconfig
path-alias are collected as **third-party reference nodes** — one per package
root (`react`, `@scope/name`, …). In the DSM they form a purple `(third-party)`
context pinned to the bottom, switchable with the **3rd-party / hide** toggle.
`node:` builtins are ignored; `import type … from 'pkg'` counts. They are pure
sinks, so they never enter cycle analysis, and they appear only on the matrix
row axis — the Graph tab is first-party (incl. cross-context) only.

## Layout

All under `dotnet/`. The code is split so it's obvious which parts are generic
and which are tech-stack-specific: **`Core/`** is ecosystem-agnostic (works for
any codebase model), **`Node/`** is the only TypeScript/Node-aware code, and the
root is the generic CLI shell. Adding another ecosystem (e.g. `dotnet`) means
adding one analyzer under a new folder that produces the same `Core.Model`.

- `Program.cs` — CLI entry + ecosystem dispatch.
- `Cli.cs` — generic CLI argument parsing (no config file).

**`Core/`** — ecosystem-agnostic:

- `Config.cs` — run config + generic derivation (`Config.For`).
- `Model.cs` — the shared dependency model (contexts / namespaces / files /
  edges / per-level SCCs / third-party); the one definition of "the codebase".
- `Scc.cs` — generic Tarjan SCC + ordered-set / sequence helpers.
- `PosixPath.cs` — `path.posix`-style normalize / join / dirname.
- `Viewer.cs` — `Render(model, config)`: turns any `Model` into the viewer HTML;
  inlines the matrix client, the graph client, and Cytoscape + fcose; payload DTOs.

**`Node/`** — TypeScript/Node ecosystem (the only TS-aware code):

- `NodeAnalyzer.cs` — `Build(config)`: scan, resolve, cluster, SCC → `Core.Model`.

**`assets/`** — embedded, inlined verbatim into the HTML:

- `dsm.client.js` — browser renderer for the **Matrix** tab.
- `graph.client.js` — browser renderer for the **Graph** tab (Cytoscape).
- `{cytoscape.min.js, layout-base.js, cose-base.js, cytoscape-fcose.js}` —
  graph libraries.
- `{template.css, template.html}` — page CSS + HTML skeleton.
