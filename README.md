# inspector-gadget

Tooling for code inspection across tech-stacks — relevant in the AI era where
manual coding is almost absent but understanding of code is ever as relevant.

A config-free **codebase dependency viewer**. Point it at a project root and it
emits a single self-contained **`codebase-dsm.html`** (no runtime; opens straight
from `file://`) into that root, with two tabs over one shared dependency model:

- **Matrix** — an interactive NDepend-style **Dependency Structure Matrix**,
  switchable across file / namespace / context via expand-collapse, with
  third-party references on the row axis.
- **Graph** — an interactive **Cytoscape** dependency graph: contexts and
  namespaces always shown, click a namespace to reveal/hide its files, edges
  coloured by directionality health (cycle / cross-context / forward / intra).

The tool is a single **.NET (`net10.0`) CLI**; the two browser renderers and
Cytoscape + fcose are embedded into the executable and inlined into the emitted
HTML, so there's nothing to install or serve. It analyzes two ecosystems today —
**TypeScript/Node source** and **compiled .NET assemblies** — and is built so
adding another is just one more analyzer producing the same model. It packages as
the cross-platform .NET tool **`lib.inspector-gadget`** (the command stays
`inspector-gadget`).

## Usage

There is **no config file** — every setting comes from CLI args and built-in
defaults.

```
inspector-gadget <node|dotnet> --code-root <dir> [-h|--help]
```

| Arg | Meaning |
|---|---|
| `<node\|dotnet>` | target ecosystem (required). `node` scans a TypeScript/Node project's source; `dotnet` scans a project's **built** .NET assemblies. |
| `--code-root <dir>` | project root to scan (**required**, no default). Also accepts `--code-root=<dir>`. |
| `-h`, `--help` | print usage and exit. |

The output `codebase-dsm.html` is always written into the `--code-root`
directory, and the page title is that directory's name. Open it in a browser.

Example:

```
inspector-gadget node --code-root C:\Projects\battlebuddy
```

### Install

Packaged as a cross-platform **.NET tool** — NuGet package id
**`lib.inspector-gadget`**, invoked with the command `inspector-gadget`:

```
dotnet tool install --global lib.inspector-gadget
inspector-gadget node --code-root <dir>
```

(`dotnet tool update --global lib.inspector-gadget` to upgrade.) Building from
source is below.

### Build & run

Requires the **.NET 10 SDK**; the project lives in the `lib.inspector-gadget/` subfolder
and has no NuGet dependencies (BCL-only).

```
# local debug (framework-dependent, no RID needed)
dotnet run --project lib.inspector-gadget -- node --code-root <dir>

# release: single-file, self-contained, OS-agnostic — pick a runtime identifier
dotnet publish lib.inspector-gadget -c Release -r win-x64   # or win-arm64, linux-x64, linux-arm64, osx-x64, osx-arm64
```

A self-contained publish bundles the .NET runtime plus all assets, so the
resulting single executable runs with no .NET install, no `node_modules`, and no
other files alongside it.

### The `node` ecosystem

`node` walks `--code-root`, skipping the directory names `node_modules`, `dist`
and `build` (and dot-dirs). All `.ts`/`.tsx` are scanned, **including `.d.ts` type
declarations** — type contracts always participate. Imports are matched with
lightweight regexes (`import`/`export … from`, side-effect `import '…'`, and
dynamic `import()`/`require()`).

#### Levels are derived from the layout

- **Context** — each immediate child directory of `--code-root`, skipping the
  excluded names and dot-dirs. A context with no scannable `.ts`/`.tsx` never
  appears.
- **Source root** (per context) — the context's `src/` subdir if it exists, else
  the context dir itself (e.g. a `.d.ts`-only contract package). Only each
  context's source root is walked, so sibling `tests/`, `__tests__/` and loose
  config files stay out of the graph.
- **Namespace** — the first path segment beneath the source root; files sitting
  directly in the source root fall into `(root)`. Names are context-qualified for
  uniqueness, e.g. `A · core`, `A · (root)`.

#### Cross-context resolution (tsconfig `paths`)

Non-relative imports are matched against the importing context's tsconfig
`paths` — each context's own `tsconfig*.json` `compilerOptions.paths` (+
`baseUrl`) is read automatically (JSONC: comments + trailing commas tolerated). A
path-alias that targets another context (e.g. `@peek-view` →
`../TOW.BattleBuddy/src/peek-view`) resolves to that context's files, producing a
**cross-context first-party edge**. Type-only cross-context imports (e.g. a
`@tow/abstractions` contract) don't enter the file graph / cycle analysis, but
are surfaced to the **Graph** tab so contract contexts still show as
depended-upon.

#### Third-party references

Non-relative imports that resolve to neither a relative file nor a tsconfig
path-alias are collected as **third-party reference nodes** — one per package
root (`react`, `@scope/name`, …). In the DSM they form a purple `(third-party)`
context pinned to the bottom, toggled with the **3rd-party / hide** control.
`node:` builtins are ignored; `import type … from 'pkg'` counts. They are pure
sinks, so they never enter cycle analysis and appear only on the matrix row axis
— the Graph tab is first-party (incl. cross-context) only.

### The `dotnet` ecosystem

`dotnet` reads the target's **built** assemblies (build the project first, e.g.
`dotnet build`). It analyzes them NDepend-style with `System.Reflection.Metadata`
(BCL-only): **context = assembly**, **namespace = C# namespace**, **leaf = type**.
First-party assemblies are discovered from the `.csproj` layout + `bin` output;
type→type edges come from both structural metadata (base/interfaces/fields/
properties/signatures/attributes/generic constraints) and decoded method-body IL.
Every referenced external assembly — including `System.*`/`Microsoft.*` — is a
third-party reference. (The cross-context / type-only edge distinctions above are
node-specific.)

## Shared model & determinism

Both ecosystems produce one ecosystem-agnostic model — files/types, dependency
edges, and Tarjan **strongly-connected components** at the file, namespace, and
context levels — which the same viewer renders into both tabs. Context and
namespace **colours** are assigned automatically from fixed pastel palettes (by
sorted name), and all node/edge/context lists are sorted, so the emitted HTML and
console report are **deterministic** across runs.

## Layout

All under the `lib.inspector-gadget/` subfolder (repo-level files — LICENSE, README,
.gitignore, .gitattributes, CLAUDE.md — stay at the repo root). The code is split so it's obvious which parts are
generic and which are tech-stack-specific: **`Core/`** is ecosystem-agnostic,
**`Analyzer/`** holds the per-ecosystem analyzers, and the root is the generic CLI
shell. Adding another ecosystem means adding one analyzer to `Analyzer/` that
produces the same `Core.Model`.

- `Program.cs` — CLI entry + ecosystem dispatch (analysis runs on a large-stack
  worker thread).
- `Cli.cs` — generic CLI argument parsing (no config file).

**`Core/`** — ecosystem-agnostic:

- `Config.cs` — run config + generic derivation (`Config.For`).
- `Model.cs` — the shared dependency model (files / edges / per-level SCCs /
  context+namespace colour maps / third-party); the one definition of "the
  codebase".
- `ModelBuilder.cs` — `Assemble(...)`: the shared finalize step (palette colours,
  the three Tarjan SCCs, cluster lists, namespace→files) that turns an analyzer's
  raw output into a complete `Model`.
- `Scc.cs` — generic Tarjan SCC + ordered-set / sequence helpers.
- `PosixPath.cs` — `path.posix`-style normalize / join / dirname.
- `Viewer.cs` — `Render(model, config)`: turns any `Model` into the viewer HTML;
  computes the triangular order, inlines the matrix client, the graph client, and
  Cytoscape + fcose, and prints the directionality report. Defines the payload DTOs.

**`Analyzer/`** — the per-ecosystem analyzers (namespace `InspectorGadget.Analyzer`):

- `NodeAnalyzer.cs` — `Build(config)`: scan `.ts/.tsx`, resolve imports → `Core.Model`.
- `DotnetAnalyzer.cs` — `Build(config)`: read built assemblies via
  `System.Reflection.Metadata` (structural + IL-body type edges) → `Core.Model`.

**`assets/`** — embedded, inlined verbatim into the HTML:

- `dsm.client.js` — browser renderer for the **Matrix** tab (vanilla DOM).
- `graph.client.js` — browser renderer for the **Graph** tab (Cytoscape).
- `{cytoscape.min.js, layout-base.js, cose-base.js, cytoscape-fcose.js}` —
  graph libraries.
- `{template.css, template.html}` — page CSS + HTML skeleton.

## License

MIT.
