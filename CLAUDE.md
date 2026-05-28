@GLOSSARY.md

# inspector-gadget — repo guide

This repo hosts **one Claude Code slash command, `/inspector-gadget`**, plus
the node tool it shells out to. It produces a **structural read** of a target
codebase as (a) an interactive **DSM** HTML artifact written into the target's
own directory, and (b) a dense **namespace-level** ASCII overview rendered in
the chat by the slash command. Not advice — interpretation.

The previous .NET CLI (a NuGet `dotnet tool` deliverable) is retired. A small
.NET console helper survives only where the language is uniquely best: reading
PE/IL via `System.Reflection.Metadata` for .NET assemblies. It is **not** a
`dotnet tool` — see [dotnet helper](GLOSSARY.md).

## Layout

```
.claude/commands/inspector-gadget.md   ◄── the slash command body
tools/inspector-gadget/
  index.mjs            orchestrator: arg parse, ecosystem auto-detect, dispatch, merge
  analyze-ts.mjs       TS/Node analyzer (in-process; regex imports + tsconfig paths)
  analyze-dotnet/      .NET analyzer (C#, BCL-only; invoked via `dotnet run`)
    Program.cs           entry: parse <code-root>, run, emit JSON to stdout
    Analyzer.cs          NDepend-style: assembly→namespace→type via System.Reflection.Metadata
    analyze-dotnet.csproj  net10.0, no PackAsTool
  model.mjs            shared finalize: Tarjan SCC (iterative), palette, cluster adj
  render.mjs           matrix-only payload + template fill → codebase-dsm.html + JSON summary
  posix-path.mjs       Node `path.posix` port — keeps TS resolution stable across OSes
  assets/
    template.html        page skeleton (matrix-only — no tabs, no graph pane)
    template.css         page CSS
    dsm.client.js        matrix renderer (vanilla DOM; reads global DATA)
install.bat         mirrors only the slash-command .md into ~/.claude/commands/
GLOSSARY.md         vocabulary anchor (imported above)
README.md           install + use
LICENSE             MIT
.gitignore .gitattributes
```

## Pipeline (data flow)

`/inspector-gadget <code-root>` →
slash command (in chat) runs **`node C:\Projects\inspector-gadget\tools\inspector-gadget\index.mjs <code-root>`** →
`index.mjs` auto-detects ecosystem(s) by file presence (`*.csproj`/`*.sln` →
.NET; `*.ts*`/`tsconfig*.json` → TS); if both, **both analyzers run and merge**
into one model; `--ecosystem=ts|dotnet|auto` overrides →
analyzer(s) produce the **raw shape**
`{files, fileCtx, fileNs, edges, tpEdges, tpPkgs, typeXctxEdges}` →
`model.mjs#assemble(raw)` finalizes (palette colours, three Tarjan SCCs at
file/namespace/context, cluster lists, ns→files) →
`render.mjs#render(model, cfg)` builds payload, fills template with inlined CSS
+ matrix client, writes **`<code-root>/codebase-dsm.html`**, prints a human
report to **stderr** and a compact JSON summary to **stdout** →
slash command parses stdout and emits the ASCII namespace-level tables in chat.

## Install / distribution — single hardcoded path, no drift

- The tool lives **only in this repo**, at
  `C:\Projects\inspector-gadget\tools\inspector-gadget\`. There is **no copy in
  `~/.claude/tools/`** — duplicating it there just creates drift.
- The slash command (`.md` file) is mirrored to `~/.claude/commands/` by
  `install.bat` so `/inspector-gadget` is invocable from any project. Both
  copies of the `.md` (repo-local + global) are pinned to the same single
  hardcoded tool path, so they cannot semantically diverge.
- **If the repo is cloned somewhere other than `C:\Projects\inspector-gadget`**,
  edit the `Locate the tool` step of `.claude/commands/inspector-gadget.md`
  (and re-run `install.bat`) to repoint the pin.

## Build · run · verify

- **Prereqs.** Node.js (any LTS) for the orchestrator; **.NET 10 SDK** when the
  target has .NET projects (helper invoked via `dotnet run`); no NuGet
  dependencies; no test project — BCL + Node stdlib only.
- **Direct run** (bypass the slash command):
  ```
  node tools/inspector-gadget/index.mjs <code-root> [--ecosystem=ts|dotnet|auto]
  ```
  Writes `<code-root>/codebase-dsm.html`; stdout = JSON summary; stderr = report.
- **Slash command:** `/inspector-gadget [code-root]`. With no arg → cwd. The
  command body lives in `.claude/commands/inspector-gadget.md`; it invokes the
  pinned path `C:\Projects\inspector-gadget\tools\inspector-gadget\index.mjs`
  directly (no fallbacks).
- **Building the .NET helper** (first run only):
  ```
  dotnet build tools/inspector-gadget/analyze-dotnet/ -c Release
  ```
  `dotnet run` from `index.mjs` triggers this automatically; cached after.
- **Smoke test the tool:** run it against this repo
  (`node tools/inspector-gadget/index.mjs C:/Projects/inspector-gadget
  --ecosystem=dotnet`) — analyzes the `analyze-dotnet/` assembly, writes a
  41-ish-KB HTML, prints a JSON summary.

## Invariants — preserve when editing

- **Determinism.** Output (HTML + stdout JSON + stderr report) must diff cleanly
  across runs. Sort node/edge/context lists. JS default sort / `<` mirrors
  ordinal; `localeCompare` is used for the triangular/alpha ordering on both
  the C# helper side and the node side. Insertion-order is preserved where the
  C# original used it (analyzers, cluster adjacency).
- **Wire contract is unenforced.** `render.mjs` writes node-id strings
  (`c:`/`n:`/`f:`) and payload keys that `assets/dsm.client.js` consumes by
  hand — no compile-time link. Change one side and you MUST change the other.
  Look for `WIRE` / `WIRE CONTRACT` comments at the top of `render.mjs` and
  `dsm.client.js`.
- **BCL-only + Node-stdlib-only.** No external NuGet refs in the helper; no
  npm dependencies in the node side. Self-contained — the tool runs straight
  out of `tools/inspector-gadget/` with no install step.
- **`assets/` are hand-edited static files**, not generated — edit in place.
  Inlined verbatim into the HTML at render time; that is what keeps the
  emitted file runtime-free.
- **`.gitattributes` forces LF** so embedded assets (and the emitted HTML) stay
  byte-stable across platforms.
- **Comment style is terse, LLM-first.** Comments carry only load-bearing
  *why* / invariants + the cross-boundary wire contract — no restatement of
  what the code already says, no decorative dividers. Keep new code in style.
- **The helper is NOT a `dotnet tool`.** No `<PackAsTool>`, no
  `<ToolCommandName>`, no `<Version>`, no NuGet packaging. If you find yourself
  adding any of those, you've misread the goal — the user's distribution
  preference is "no dotnet tool deliverable"; the helper exists only because
  `System.Reflection.Metadata` is the only clean way to read PE/IL.
- **Single source of truth for the tool path.** The tool lives at one pinned
  path; no global copy in `~/.claude/tools/`. If you find yourself adding
  fallback paths or a tool-mirror step to `install.bat`, you're re-introducing
  the drift this design exists to prevent.

## Model conventions

Everything derives from the target's layout — no config file.

**TS/Node:**
- **Context** = each top-level dir under `--code-root` (minus dot-dirs +
  `node_modules`/`dist`/`build`). Contexts with no `.ts/.tsx` never appear.
- **Source root** per context = its `src/` if present, else the dir itself.
- **Namespace** = first path segment below source root; root files → `(root)`.
- **Cross-context resolution** = each context's `tsconfig*.json`
  `compilerOptions.paths` (+ `baseUrl`), JSONC-tolerant.
- **Edges** = value imports (`import/export … from`, side-effect `import '…'`,
  dynamic `import()`/`require()`). Whole-statement `import type` is excluded
  from cycles; cross-context type-only imports → `typeXctxEdges` (matrix-only,
  not a cycle).
- **Third-party** = non-relative, non-alias imports (excl. `node:`). One per
  package root (`react`, `@scope/name`). Pure sinks — matrix row axis only.

**.NET** (NDepend-style):
- **Context** = first-party assembly (discovered from `.csproj` + `bin/`
  output; newest mtime wins). Build the target first.
- **Namespace** = C# namespace (root types → `(root)`); context-qualified.
- **Leaf** = type. Edges = type→type via structural metadata (base/interfaces/
  fields/properties/sigs/attributes/generic constraints) + decoded method-body
  IL.
- **Third-party** = every referenced external assembly (`System.*`,
  `Microsoft.*`, NuGet, …). Sinks.
- **No** type-only or cross-context edge concept — those are TS-only.

**Both:** colours assigned from fixed pastel palettes by sorted name →
deterministic.

## DSM (`assets/dsm.client.js`)

Hierarchical NDepend-style DSM: context → namespace → file via
expand/collapse. Cell `(r,c)` = "row depends on col". Triangular
(dependency-first) or alphabetical order; **Direct** or **+ Indirect**
(transitive reachability). Third-party rows pinned at the bottom (purple,
`tpcell`), togglable (`3rd-party / hide`); columns are **first-party only**.
Parent cells aggregate descendants; ancestor/descendant + diagonal render as
"nesting". Click a cell → list the imports behind it. Collapse-all stops at
the namespace level.

## Slash-command output (in chat)

Namespace-level only — no per-file rows. Sections (skip a section if empty):

- Header line (title, totals, cycle counts).
- **Contexts** table — `ctx | ns | files | in→ | out→ | internal`.
- **Namespaces** table — `ctx · ns | files | in→ | out→ | internal`, in
  dependency-first order. First 40 rows; line after if truncated.
- **Context cycles** (if any) — `A ↔ B ↔ … ↔ A` per cycle.
- **Namespace cycles** (if any) — same shape.
- **Cross-context asymmetries** — top 10, `from → to | edges`.
- **Third-party concentration** — top 15, `package | consumers (ns)`.
- Closing `file://` link to the HTML viewer.

No prose paragraphs. No DSM/SCC explainers. No advice.
