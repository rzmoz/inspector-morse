// Loads inspector.gadget.json — the per-project settings file. The tool itself
// is generic; everything project-specific (which source roots to scan, import
// aliases, bounded contexts, namespace clusters, output names) lives in that
// JSON. The file's own directory is the project ROOT: source roots resolve
// relative to it and outputs default there.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const CONFIG_NAME = 'inspector.gadget.json';

function findUp(name, from) {
  let dir = resolve(from);
  for (;;) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve + parse the settings file.
 * @param {string} [explicitPath] from `--config`; else $IG_CONFIG_PATH; else
 *   the nearest inspector.gadget.json walking up from cwd.
 */
export function loadConfig(explicitPath) {
  const found = explicitPath || process.env.IG_CONFIG_PATH || findUp(CONFIG_NAME, process.cwd());
  if (!found) {
    throw new Error(`${CONFIG_NAME} not found — pass --config <path> or run from a directory that contains it.`);
  }
  const configPath = resolve(found);
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const root = dirname(configPath);
  const outDir = resolve(root, raw.output?.dir ?? '.');

  const compile = (list) => (list ?? []).map((e) => ({ re: new RegExp(e.match), name: e.name, colour: e.colour ?? '#ffffff' }));

  return {
    configPath,
    root,
    title: raw.title ?? 'Dependency Structure Matrix',
    srcRoots: raw.srcRoots ?? [],
    aliases: Object.entries(raw.aliases ?? {}),
    exclude: raw.exclude ?? ['node_modules', 'dist', 'build'],
    includeDts: raw.includeDts ?? [],
    contexts: compile(raw.contexts),
    namespaces: compile(raw.namespaces),
    output: {
      graph: resolve(outDir, raw.output?.graph ?? 'codebase-graph.namespaces.svg'),
      dsm: resolve(outDir, raw.output?.dsm ?? 'codebase-dsm.html'),
      fileLevelGraph: resolve(outDir, raw.output?.fileLevelGraph ?? 'codebase-graph.svg'),
      emitFileLevel: raw.output?.emitFileLevel ?? false,
    },
  };
}
