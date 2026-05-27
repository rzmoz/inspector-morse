using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using InspectorGadget.Core;

namespace InspectorGadget.Analyzer;

// Node/TypeScript analyzer: walk .ts/.tsx (incl. .d.ts), resolve relative +
// tsconfig-path imports → file edges, collect non-relative imports as third-party,
// produce Core.Model. (Sibling DotnetAnalyzer does the same for compiled .NET.)
internal static class NodeAnalyzer
{
    // dirs skipped while walking; .d.ts are always scanned
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

        // discover contexts + source roots from the tree
        var contextDirs = SafeDirNames(root)
            .Where(n => !n.StartsWith('.') && !exclude.Contains(n))
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        var srcRootOf = contextDirs.ToDictionary(
            c => c,
            c => Directory.Exists(Path.Combine(root, c, "src")) ? c + "/src" : c,
            StringComparer.Ordinal);

        // collect source files, tag each with context + namespace
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
                    fileNs[r] = ctx + Model.NsSep + (slash >= 0 ? rest[..slash] : "(root)");
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

        // cross-context path aliases from each context's tsconfig
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

        // resolve an import specifier to a scanned file (else null)
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

        // build file→file import edges
        var edges = new List<Edge>();
        var seen = new HashSet<Edge>();
        var tpEdges = new List<TpRef>();
        var tpSeen = new HashSet<TpRef>();
        var tpPkgs = new HashSet<string>(StringComparer.Ordinal);
        var typeXctxEdges = new List<Edge>();
        var txSeen = new HashSet<Edge>();

        void AddInternal(string f, string? tgt)
        {
            if (tgt != null && tgt != f)
            {
                var e = new Edge(f, tgt);
                if (seen.Add(e)) edges.Add(e);
            }
        }
        void AddExternal(string f, string spec)
        {
            if (spec.StartsWith('.')) return;
            string? pkg = PkgRoot(spec);
            if (pkg == null) return;
            tpPkgs.Add(pkg);
            var e = new TpRef(f, pkg);
            if (tpSeen.Add(e)) tpEdges.Add(e);
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
                    var e = new Edge(f, tgt);
                    if (txSeen.Add(e)) typeXctxEdges.Add(e);
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

    // match Node readFileSync(utf8): no BOM strip
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

    // tsconfig is JSONC (comments + trailing commas); null when paths absent
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
