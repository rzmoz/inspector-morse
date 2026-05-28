# inspector-gadget

A Claude Code slash command for a **structural read** of any codebase. Point
`/inspector-gadget` at a project root and you get:

- **Interactive DSM** — a self-contained `codebase-dsm.html` (no runtime, opens
  from `file://`) with an NDepend-style **Dependency Structure Matrix** over the
  whole codebase: context → namespace → file, expand/collapse, triangular or
  alphabetical order, direct or transitive reachability, third-party rows
  toggleable.
- **Namespace-level ASCII overview, in chat** — totals, contexts/namespaces in
  dependency-first order, per-level cycles, cross-context asymmetries,
  third-party concentration. No prose, no advice — just the read.

Two ecosystems today, **auto-detected**:

- **TS/Node** — scans `.ts`/`.tsx` source, resolves imports + tsconfig `paths`.
- **.NET** — reads built assemblies via `System.Reflection.Metadata`
  (BCL-only): assembly → namespace → type, type→type edges from structural
  metadata + decoded method-body IL.

A mixed repo (TS frontend + .NET backend in one root) just works — both
analyzers run, results merge into one model.

## Install

The repo authors the tool here. The slash command is **pinned to a single
hardcoded path** — no fallbacks, no global tool copy, no drift. The tool lives
only in this repo; only the slash command file gets mirrored globally so
`/inspector-gadget` is invocable from any project.

**Pinned tool path** (edit the slash command if your clone lives elsewhere):
```
C:\Projects\inspector-gadget\tools\inspector-gadget\index.mjs
```

**Per-repo (this repo only).** Already wired:
```
.claude/commands/inspector-gadget.md     ← the slash command
tools/inspector-gadget/                  ← the node tool + dotnet helper
```

**Globally for every project.** Run `install.bat` — it copies the slash command
into `%USERPROFILE%\.claude\commands\`. The tool itself stays in this repo;
both `.md` files point at the same pinned path.

**Prerequisites.**
- **Node.js** (any LTS). Required for the orchestrator.
- **.NET 10 SDK.** Required only when the target has `.csproj`/`.sln`
  (the dotnet helper is invoked via `dotnet run`). First run takes a few
  seconds to build the helper; cached after.
- No NuGet refs, no npm dependencies, no installer.

## Use

```
/inspector-gadget [code-root]
```

With no argument → the current working directory. With a directory path → that
directory. The HTML viewer lands at `<code-root>/codebase-dsm.html` and the
in-chat ASCII overview prints alongside.

You can also run the tool directly without Claude Code:

```
node tools/inspector-gadget/index.mjs <code-root> [--ecosystem=ts|dotnet|auto]
```

- **stdout** = compact JSON summary (what the slash command consumes).
- **stderr** = human-readable report (cycles, totals, output path).
- Exit 0 on success.

`--ecosystem=` forces an analyzer when auto-detection picks wrong (e.g. a
repo with `.cs` config scripts but you only want TS, or vice versa).

## How the read is shaped

Everything derives from the target's layout — there is no config file.

### TS/Node ecosystem

| Level | What it is |
|---|---|
| **Context** | Each immediate child directory of `--code-root` (skipping dot-dirs + `node_modules`/`dist`/`build`). Contexts with no `.ts/.tsx` are dropped. |
| **Source root** (per context) | `src/` if present, else the context dir. Sibling `tests/` etc. are not walked. |
| **Namespace** | First path segment under the source root; files directly in source root → `(root)`. Names are context-qualified, e.g. `Core · Model`. |
| **Edge** | Value import. `import type` whole statements are excluded from cycles; cross-context type-only imports still surface (matrix-only, never a cycle). |
| **Cross-context** | Each context's `tsconfig*.json` `compilerOptions.paths` (+ `baseUrl`) is auto-read (JSONC tolerated). Path aliases that resolve into a sibling context produce cross-context edges. |
| **Third-party** | Non-relative imports that aren't a tsconfig alias (excluding `node:`). One node per package root. Sinks: never in cycles. |

### .NET ecosystem

| Level | What it is |
|---|---|
| **Context** | First-party assembly. Discovered from `.csproj` layout + `bin/` output; newest write time wins. **Build the target first** (`dotnet build`). |
| **Namespace** | C# namespace; root types → `(root)`. Context-qualified. |
| **Leaf** | Type. |
| **Edge** | Type→type. Sources: base, interfaces, fields, properties, method signatures, attributes, generic constraints, **plus** decoded method-body IL (every token-bearing opcode). |
| **Third-party** | Every referenced external assembly — `System.*`, `Microsoft.*`, NuGet, … Sinks. |

The cross-context / type-only edge distinctions are TS-specific.

## Output

Both runs (slash command and direct CLI) write the same artifact:
`<code-root>/codebase-dsm.html` — a self-contained HTML file with the
interactive DSM. The slash command additionally prints a namespace-level ASCII
overview in chat.

### Determinism

Sorted node/edge/context lists, deterministic palette assignment by sorted
name, stable Tarjan SCC. The HTML, the JSON summary, and the report all diff
cleanly across runs on the same input.

## Why no `dotnet tool` anymore

The previous incarnation packaged as the NuGet tool `lib.inspector-gadget`.
This one doesn't, by preference. The .NET helper that survives —
`tools/inspector-gadget/analyze-dotnet/` — is a plain BCL-only console project
invoked via `dotnet run`; it has no `PackAsTool`, no `ToolCommandName`, no
`Version`. It exists only because `System.Reflection.Metadata` is the only
clean way to read PE/IL. Everything else lives in node.

## Layout (top of repo)

```
.claude/commands/inspector-gadget.md   the slash command body
tools/inspector-gadget/
  index.mjs            orchestrator + auto-detect + dispatch + merge
  analyze-ts.mjs       TS/Node analyzer (in-process)
  analyze-dotnet/      .NET analyzer (BCL-only C# helper, dotnet run)
  model.mjs            Tarjan SCC, palette, clusters → finalized Model
  render.mjs           matrix payload + template fill + summary
  posix-path.mjs       Node `path.posix` port
  assets/              template.html, template.css, dsm.client.js (inlined)
CLAUDE.md  GLOSSARY.md  README.md  LICENSE  .gitignore  .gitattributes
```

## License

MIT.
