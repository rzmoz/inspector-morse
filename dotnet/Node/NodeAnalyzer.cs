using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using InspectorMorse.Core;

namespace InspectorMorse.Node;

// Node / TypeScript ecosystem analyzer — the only TypeScript-aware code in the
// tool. Walks every .ts/.tsx under the derived source roots (incl. .d.ts),
// resolves the project's own relative + tsconfig-path imports into a file
// dependency graph, clusters files into namespaces inside contexts, runs Tarjan
// SCC at file / namespace / context level, and collects unresolved non-relative
// imports as third-party references. Produces the ecosystem-agnostic Core.Model
// that Core.Viewer renders. A future .NET ecosystem analyzer would sit beside
// this and produce the same Model.
internal static class NodeAnalyzer
{
    // node-ecosystem default: directory names skipped while walking. .d.ts type
    // declarations are ALWAYS scanned.
    public static readonly string[] DefaultExcludes = { "node_modules", "dist", "build" };

    private static readonly Regex FromRe = new(@"\b(?:import|export)\b([^'"";]*?)\bfrom\s*['""]([^'""]+)['""]");
    private static readonly Regex SideRe = new(@"\bimport\s+['""]([^'""]+)['""]");
    private static readonly Regex DynRe = new(@"(?:\bimport\b|\brequire)\s*\(\s*['""]([^'""]+)['""]\s*\)");
    private static readonly Regex TypeOnlyRe = new(@"^\s+type\b");
    private static readonly Regex TsconfigRe = new(@"^tsconfig.*\.json$");

    private sealed record Alias(bool IsWild, string Key, string Target);

    public static Model Build(Config config)
    {
        string root = config.Root;
        var exclude = new HashSet<string>(config.Exclude, StringComparer.Ordinal);

        // ---- discover bounded contexts + their source roots from the tree ----
        var contextDirs = SafeDirNames(root)
            .Where(n => !n.StartsWith('.') && !exclude.Contains(n))
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        var srcRootOf = contextDirs.ToDictionary(
            c => c,
            c => Directory.Exists(Path.Combine(root, c, "src")) ? c + "/src" : c,
            StringComparer.Ordinal);

        // ---- collect source files, tagging each with its context + namespace ----
        var files = new List<string>();
        var fileCtx = new Dictionary<string, string>(StringComparer.Ordinal);
        var fileNs = new Dictionary<string, string>(StringComparer.Ordinal);

        void Walk(string nativeDir, string posixDir, string ctx, string srcRoot)
        {
            string[] entries;
            try { entries = Directory.GetFileSystemEntries(nativeDir); }
            catch { return; }
            foreach (var p in entries)
            {
                string name = Path.GetFileName(p);
                if (Directory.Exists(p))
                {
                    if (exclude.Contains(name)) continue;
                    Walk(p, posixDir + "/" + name, ctx, srcRoot);
                }
                else if (name.EndsWith(".ts", StringComparison.Ordinal) || name.EndsWith(".tsx", StringComparison.Ordinal))
                {
                    string r = posixDir + "/" + name;
                    files.Add(r);
                    fileCtx[r] = ctx;
                    string rest = r.StartsWith(srcRoot + "/", StringComparison.Ordinal) ? r[(srcRoot.Length + 1)..] : r;
                    int slash = rest.IndexOf('/');
                    fileNs[r] = $"{ctx} · {(slash >= 0 ? rest[..slash] : "(root)")}";
                }
            }
        }

        foreach (var c in contextDirs)
        {
            string srcRoot = srcRootOf[c];
            Walk(Path.Combine(root, ToNative(srcRoot)), srcRoot, c, srcRoot);
        }
        files.Sort(StringComparer.Ordinal); // deterministic order
        var fileSet = new HashSet<string>(files, StringComparer.Ordinal);

        // ---- cross-context path aliases, auto-read from each context's tsconfig ----
        var aliasOf = new Dictionary<string, List<Alias>>(StringComparer.Ordinal);
        foreach (var c in contextDirs)
        {
            var list = new List<Alias>();
            var tsfiles = SafeFileNames(Path.Combine(root, c))
                .Where(n => TsconfigRe.IsMatch(n))
                .OrderBy(n => n, StringComparer.Ordinal);
            foreach (var tf in tsfiles)
            {
                var cfg = ReadTsconfig(Path.Combine(root, c, tf));
                if (cfg is null) continue; // no compilerOptions.paths → skip
                string baseRel = cfg.Value.BaseUrl != null
                    ? PosixPath.Normalize(PosixPath.Join(c, cfg.Value.BaseUrl.Replace('\\', '/')))
                    : c;
                foreach (var (key, first) in cfg.Value.Paths)
                {
                    string target = PosixPath.Normalize(PosixPath.Join(baseRel, first.Replace('\\', '/')));
                    if (key.EndsWith("/*", StringComparison.Ordinal)) list.Add(new Alias(true, key[..^2], target));
                    else list.Add(new Alias(false, key, target));
                }
            }
            if (list.Count > 0) aliasOf[c] = list;
        }

        // ---- resolve an import specifier to a scanned file (null otherwise) ----
        string? ResolveFile(string @base)
        {
            string noJs = @base.EndsWith(".js", StringComparison.Ordinal) ? @base[..^3] : @base;
            foreach (var b in new[] { @base, noJs })
                foreach (var cand in new[] { b, b + ".ts", b + ".tsx", b + "/index.ts", b + "/index.tsx" })
                    if (fileSet.Contains(cand)) return cand;
            return null;
        }

        string? Resolve(string fromFile, string spec)
        {
            if (spec.StartsWith('.'))
                return ResolveFile(PosixPath.Normalize(PosixPath.Join(PosixPath.Dirname(fromFile), spec)));
            if (aliasOf.TryGetValue(fileCtx[fromFile], out var aliases))
            {
                foreach (var a in aliases)
                {
                    if (a.IsWild)
                    {
                        if (spec.StartsWith(a.Key + "/", StringComparison.Ordinal))
                        {
                            string? hit = ResolveFile(PosixPath.Normalize(ReplaceFirst(a.Target, '*', spec[(a.Key.Length + 1)..])));
                            if (hit != null) return hit;
                        }
                    }
                    else if (spec == a.Key)
                    {
                        string? hit = ResolveFile(PosixPath.Normalize(a.Target));
                        if (hit != null) return hit;
                    }
                }
            }
            return null;
        }

        static string? PkgRoot(string spec)
        {
            if (spec.StartsWith("node:", StringComparison.Ordinal)) return null;
            var parts = spec.Split('/');
            return spec.StartsWith('@') && parts.Length > 1 ? parts[0] + "/" + parts[1] : parts[0];
        }

        // ---- build edges (file → file import dependencies) ----
        var edges = new List<(string, string)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var tpEdges = new List<(string, string)>();
        var tpSeen = new HashSet<string>(StringComparer.Ordinal);
        var tpPkgs = new HashSet<string>(StringComparer.Ordinal);
        var typeXctxEdges = new List<(string, string)>();
        var txSeen = new HashSet<string>(StringComparer.Ordinal);

        void AddInternal(string f, string? tgt)
        {
            if (tgt != null && tgt != f)
            {
                string key = f + ">" + tgt;
                if (seen.Add(key)) edges.Add((f, tgt));
            }
        }
        void AddExternal(string f, string spec)
        {
            if (spec.StartsWith('.')) return;
            string? pkg = PkgRoot(spec);
            if (pkg == null) return;
            tpPkgs.Add(pkg);
            string key = f + ">" + pkg;
            if (tpSeen.Add(key)) tpEdges.Add((f, pkg));
        }

        foreach (var f in files)
        {
            string src;
            try { src = ReadText(Path.Combine(root, ToNative(f))); }
            catch { continue; }

            foreach (Match m in FromRe.Matches(src))
            {
                bool typeOnly = TypeOnlyRe.IsMatch(m.Groups[1].Value);
                string? tgt = Resolve(f, m.Groups[2].Value);
                if (tgt == null) { AddExternal(f, m.Groups[2].Value); continue; }
                if (!typeOnly) AddInternal(f, tgt);
                else if (fileCtx[f] != fileCtx[tgt] && tgt != f)
                {
                    string k = f + ">" + tgt;
                    if (txSeen.Add(k)) typeXctxEdges.Add((f, tgt));
                }
            }
            foreach (Match m in SideRe.Matches(src))
            {
                string? t = Resolve(f, m.Groups[1].Value);
                if (t != null) AddInternal(f, t); else AddExternal(f, m.Groups[1].Value);
            }
            foreach (Match m in DynRe.Matches(src))
            {
                string? t = Resolve(f, m.Groups[1].Value);
                if (t != null) AddInternal(f, t); else AddExternal(f, m.Groups[1].Value);
            }
        }

        return ModelBuilder.Assemble(files, fileCtx, fileNs, edges, tpEdges, tpPkgs, typeXctxEdges);
    }

    private static string ReplaceFirst(string s, char ch, string rep)
    {
        int i = s.IndexOf(ch);
        return i < 0 ? s : s[..i] + rep + s[(i + 1)..];
    }

    private static string ToNative(string posix) => posix.Replace('/', Path.DirectorySeparatorChar);

    // Node readFileSync(p,'utf8') does not strip a BOM; decode raw bytes so we match.
    private static string ReadText(string path) => Encoding.UTF8.GetString(File.ReadAllBytes(path));

    private static IEnumerable<string> SafeDirNames(string dir)
    {
        try { return Directory.GetDirectories(dir).Select(Path.GetFileName!).Cast<string>(); }
        catch { return Array.Empty<string>(); }
    }

    private static IEnumerable<string> SafeFileNames(string dir)
    {
        try { return Directory.GetFiles(dir).Select(Path.GetFileName!).Cast<string>(); }
        catch { return Array.Empty<string>(); }
    }

    // tsconfig is JSONC: comments + trailing commas. System.Text.Json handles both
    // natively. Returns (baseUrl, [key → first target]) or null when paths absent.
    private static (string? BaseUrl, List<(string Key, string First)> Paths)? ReadTsconfig(string file)
    {
        try
        {
            string text = ReadText(file);
            using var doc = JsonDocument.Parse(text, new JsonDocumentOptions
            {
                CommentHandling = JsonCommentHandling.Skip,
                AllowTrailingCommas = true,
            });
            if (!doc.RootElement.TryGetProperty("compilerOptions", out var co) || co.ValueKind != JsonValueKind.Object)
                return null;
            if (!co.TryGetProperty("paths", out var paths) || paths.ValueKind != JsonValueKind.Object)
                return null;

            string? baseUrl = co.TryGetProperty("baseUrl", out var bu) && bu.ValueKind == JsonValueKind.String
                ? bu.GetString() : null;

            var list = new List<(string, string)>();
            foreach (var prop in paths.EnumerateObject())
            {
                if (prop.Value.ValueKind != JsonValueKind.Array || prop.Value.GetArrayLength() == 0) continue;
                var firstEl = prop.Value[0];
                string first = firstEl.ValueKind == JsonValueKind.String ? firstEl.GetString()! : firstEl.GetRawText();
                list.Add((prop.Name, first));
            }
            return (baseUrl, list);
        }
        catch { return null; }
    }
}
