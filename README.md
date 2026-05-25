# inspector.gadget

Tooling for code inspection on various tech-stacks — relevant in the AI era where
manual coding is almost absent but understanding of code is ever as relevant.

Config-driven **codebase dependency** tooling. Point it at an
`inspector.gadget.json` and it emits:

- **`codebase-graph.namespaces.svg`** — a namespace-level dependency graph
  (Graphviz), bounded contexts as tinted clusters, edges coloured by
  directionality health (cycle / cross-context / forward / intra).
- **`codebase-dsm.html`** — a self-contained, interactive **Dependency Structure
  Matrix** (no runtime; opens from `file://`), switchable across file /
  namespace / context levels.

Both share one model: a `.ts`/`.tsx` import scan → file dependency graph →
namespace/context clustering → Tarjan **SCC** at all three levels. Whole-statement
`import type` / `export type` edges are excluded (they erase at build, so they
are not runtime dependencies and must not form cycles).

## Usage

The tool is generic; all project-specifics live in an `inspector.gadget.json` in
the **project** being analysed. That file's directory is the project root
(source roots resolve relative to it) and outputs default there.

```
node /path/to/inspector.gadget/bin/cli.mjs [graph|dsm|all] [--config <path>]
```

The config is found via `--config`, else `$IG_CONFIG_PATH`, else the nearest
`inspector.gadget.json` walking up from the current directory. `all` (default)
emits both. (If linked via `npm link`, the `inspector.gadget` bin runs anywhere.)

## `inspector.gadget.json`

```jsonc
{
  "title": "My Project · Dependency Structure Matrix",   // DSM <title>/<h1>
  "srcRoots": ["packages/a/src", "packages/b/src"],       // scanned dirs (relative to this file)
  "aliases": { "@app": "packages/a/src" },                // non-relative import aliases → repo-relative path
  "exclude": ["node_modules", "dist", "build"],           // directory names skipped while walking
  "includeDts": ["contracts/index.d.ts"],                 // .d.ts files to include (otherwise .d.ts is skipped)
  "contexts": [                                           // bounded contexts (first match wins)
    { "match": "^packages/a/", "name": "A", "colour": "#eaf2ff" }
  ],
  "namespaces": [                                         // namespaces within contexts (specific before general)
    { "match": "^packages/a/src/core/", "name": "A · core", "colour": "#cfe8ff" },
    { "match": "^packages/a/src/", "name": "A · app", "colour": "#f0f0f0" }
  ],
  "output": {
    "dir": ".",                                           // default: same dir as this file
    "graph": "codebase-graph.namespaces.svg",
    "dsm": "codebase-dsm.html",
    "fileLevelGraph": "codebase-graph.svg",
    "emitFileLevel": false
  }
}
```

`match` strings are compiled with `new RegExp(...)` and tested against
repo-root-relative POSIX paths (e.g. `packages/a/src/core/x.ts`). `contexts` and
`namespaces` are evaluated **in order** — list specific patterns before general
catch-alls.

## Layout

- `bin/cli.mjs` — CLI entry / dispatch.
- `src/config.mjs` — load + validate `inspector.gadget.json`.
- `src/codebase-model.mjs` — `buildModel(config)`: scan, resolve, cluster, SCC.
- `src/graph.mjs` — Graphviz namespace SVG + console directionality report.
- `src/dsm.mjs` — interactive DSM HTML (inlines `src/dsm.client.js`).
