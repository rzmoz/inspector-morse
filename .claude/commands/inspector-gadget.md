---
description: Structural read of a codebase — interactive DSM matrix HTML + dense in-chat namespace-level tables. TS/Node + .NET (auto-detected).
argument-hint: [code-root]
---

You are running `/inspector-gadget`. Arguments: `$ARGUMENTS`.

## Procedure

1. **Resolve target.** If `$ARGUMENTS` is empty, target = the current working
   directory. Otherwise target = `$ARGUMENTS` (a directory path; first positional
   wins, ignore trailing words). Resolve to absolute via `Bash` if needed.

2. **Locate the tool.** Try these in order, use the first that exists:
   - `<repo-root>/tools/inspector-gadget/index.mjs` (this repo authoring home)
   - `$HOME/.claude/tools/inspector-gadget/index.mjs` (globally promoted copy)
   - `$USERPROFILE/.claude/tools/inspector-gadget/index.mjs` (Windows global)

   If none exist, stop. Emit this error verbatim — substitute the three actual
   paths you tried — and do not try to repair the install:

   > **inspector-gadget tool not found.**
   > Tried:
   > &nbsp;&nbsp;`<absolute repo path>/tools/inspector-gadget/index.mjs`
   > &nbsp;&nbsp;`<absolute $HOME>/.claude/tools/inspector-gadget/index.mjs`
   > &nbsp;&nbsp;`<absolute $USERPROFILE>\.claude\tools\inspector-gadget\index.mjs`
   >
   > Run `install.bat` from the inspector-gadget repo
   > (https://github.com/rzmoz/inspector-gadget) for a one-click install, or
   > copy `tools/inspector-gadget/` into any of the three paths above.

3. **Run the analyzer.** Invoke:
   `node <tool>/index.mjs <target>`
   Capture stdout (compact JSON summary) and stderr (human-readable report +
   warnings). If exit code ≠ 0, print stderr verbatim and stop.

4. **Parse stdout** as JSON. Shape:
   - `title`, `output` (absolute HTML path), `htmlSizeKB`
   - `totals: {files, edges, namespaces, contexts, thirdParty, fileCycles,
     nsCycles, ctxCycles}`
   - `contexts: [{name, ns, files, in, out, internal, colour}]` — context-major
     dep-first order
   - `namespaces: [{name (= "ctx · ns"), leaf, ctx, files, in, out, internal}]`
     — dep-first order, contiguous per context
   - `sccs: {context: string[][], namespace: string[][]}` — file-level SCCs are
     matrix-only, not emitted here
   - `crossCtxAsymmetries: [{from, to, count}]` — A→B with no B→A
   - `thirdParty: [{package, consumers}]` — sorted by consumer count desc

5. **Emit in chat — namespace level only, no per-file rows.** Use ASCII tables
   (Unicode box-drawing acceptable). Column widths sized to fit. Suggested
   sections, in order:

   - **Header line.** `inspector-gadget · {title} · {output}` then one line
     `files {n} | edges {n} | ns {n} | ctx {n} | 3p {n}` then if any cycles:
     `cycles: ctx {n}, ns {n}, file {n}` else `cycles: none ✓`.
   - **Contexts** table. Columns: `ctx | ns | files | in→ | out→ | internal`.
     Rows in the order given.
   - **Namespaces** table. Columns: `ctx · ns | files | in→ | out→ | internal`.
     Rows in the order given. If > 40 rows, show the first 40 and add a line
     `… and {N-40} more (see matrix)`.
   - **Context cycles** — print each as `A ↔ B ↔ … ↔ A`. Skip the section if
     none.
   - **Namespace cycles** — same shape. Skip if none.
   - **Cross-context asymmetries** table. Columns: `from → to | edges`. Top 10.
     Skip if empty.
   - **Third-party concentration** table. Columns: `package | consumers (ns)`.
     Top 15. Skip if empty.
   - **Closing line:** `→ matrix viewer: file://{output}` so the user can click
     it open.

6. **Do not** explain what a DSM is, what an SCC is, what each table means, or
   the analyzer's methodology. Do not editorialize. Do not suggest fixes
   (that's outside this command's scope — it interprets, it does not advise).
   No prose paragraphs. If the user asks follow-up questions, then explain.

## Notes

- Ecosystem auto-detects from file presence (`*.csproj`/`*.sln` → .NET via the
  `dotnet run` helper; `*.ts*`/`tsconfig*.json` → TS via in-process node
  analyzer). Pass `--ecosystem=ts` or `--ecosystem=dotnet` through if the user
  forced one.
- First .NET run will spend a few seconds building the helper project — that's
  `dotnet run`, not "the tool is wrong". Subsequent runs are cached.
- The HTML viewer is the deep artifact (file-level matrix, expand/collapse,
  direct/+indirect, third-party toggle). The in-chat tables are the
  namespace-level overview.
