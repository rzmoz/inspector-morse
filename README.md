# inspector.gadget

Tooling for code inspection on various tech-stacks — relevant in the AI era where
manual coding is almost absent but understanding of code is ever as relevant.

Config-driven **codebase dependency** tooling. Point it at an
`inspector.gadget.json` and it emits a single self-contained
**`codebase-dsm.html`** (no runtime; opens from `file://`) with two tabs:

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

## Usage

The tool is generic; all project-specifics live in an `inspector.gadget.json` in
the **project** being analysed. That file's directory is the project root — it
is scanned to **derive** contexts, source roots and namespaces (see below) and
outputs default there.

```
node /path/to/inspector.gadget/bin/cli.mjs [graph|dsm|all] [--config <path>]
```

The config is found via `--config`, else `$IG_CONFIG_PATH`, else the nearest
`inspector.gadget.json` walking up from the current directory. `graph`, `dsm`
and `all` all emit the same combined viewer (the names are kept for
familiarity). (If linked via `npm link`, the `inspector.gadget` bin runs
anywhere.)

## `inspector.gadget.json`

Every key is optional — a bare `{}` works. The file only declares scan mechanics
and cosmetics; the three **levels** are derived from the directory tree (next
section), not configured.

```jsonc
{
  "title": "My Project · Dependency Structure Matrix",   // DSM <title>/<h1>
  "exclude": ["node_modules", "dist", "build"],           // directory names skipped while walking (REPLACES the default, not merged)
  "includeDts": ["contracts/index.d.ts"],                 // .d.ts files to include (otherwise .d.ts is skipped)
  "output": {
    "dir": ".",                                           // default: same dir as this file
    "dsm": "codebase-dsm.html"                            // the combined Matrix + Graph viewer
  }
}
```

### Levels are derived from the layout

- **Context** — each immediate child directory of the settings-file dir (the
  project root), skipping `exclude` names and dot-dirs. A context with no
  scannable `.ts`/`.tsx` simply never appears.
- **Source root** (per context) — the context's `src/` subdir if it exists, else
  the context dir itself (e.g. a `.d.ts`-only contract package). This is what
  replaces the old `srcRoots`: only each context's source root is walked, so
  sibling `tests/`, `__tests__/` and loose config files stay out of the graph.
- **Namespace** — the first path segment beneath the source root; files sitting
  directly in the source root fall into `(root)`. Names are context-qualified
  for uniqueness, e.g. `A · core`, `A · (root)`.

Context and namespace **colours** are assigned automatically from fixed pastel
palettes (by sorted name), so output is deterministic across runs.

### Third-party references

Non-relative imports that don't resolve to a scanned file are collected as
**third-party reference nodes** — one per package root (`react`, `@scope/name`,
…). In the DSM they form a purple `(third-party)` context pinned to the bottom,
switchable with the **3rd-party / hide** toggle. `node:` builtins are ignored;
`import type … from 'pkg'` counts (a type-only import is still a real reference).
They are pure sinks, so they never enter cycle analysis, and they appear only on
the matrix row axis — the Graph tab is first-party only.

## Layout

- `bin/cli.mjs` — CLI entry / dispatch.
- `src/config.mjs` — load + validate `inspector.gadget.json`.
- `src/codebase-model.mjs` — `buildModel(config)`: scan, resolve, cluster, SCC.
- `src/dsm.mjs` — assembles the combined viewer HTML; inlines the matrix client,
  the graph client, and Cytoscape + fcose from `node_modules`.
- `src/dsm.client.js` — browser renderer for the **Matrix** tab.
- `src/graph.client.js` — browser renderer for the **Graph** tab (Cytoscape).
