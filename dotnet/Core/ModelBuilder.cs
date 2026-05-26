namespace InspectorMorse.Core;

// Ecosystem-agnostic finalize step. An analyzer's only job is to produce the raw
// leaf nodes (files/types), their context+namespace tags, the dependency edges,
// and the third-party references; this turns those into a complete Model —
// deterministic palette colours, per-level Tarjan SCCs, cluster lists, and the
// namespace→files map. Both the Node and Dotnet analyzers call this, so adding a
// new ecosystem is just "write a producer".
internal static class ModelBuilder
{
    private static readonly string[] CtxPalette =
        { "#eaf2ff", "#fdeef0", "#ecfbef", "#fff5d6", "#f3e8ff", "#e6fbfb", "#fef3e2", "#eef2f7" };
    private static readonly string[] NsPalette =
        { "#cfe8ff", "#ffd1dc", "#d6f5d6", "#ffe9a6", "#e6c9e0", "#cfe8e0", "#ffdfba", "#d9d9d9",
          "#ffc9c9", "#cce5ff", "#ffe0b3", "#ffb3ba", "#c9e4ff", "#d6d6f5", "#f5d6d6", "#d6f5ec" };

    public static Model Assemble(
        List<string> files,
        Dictionary<string, string> fileCtx,
        Dictionary<string, string> fileNs,
        List<(string a, string b)> edges,
        List<(string f, string pkg)> tpEdges,
        IEnumerable<string> tpPkgs,
        List<(string a, string b)> typeXctxEdges)
    {
        string Ctx(string f) => fileCtx.TryGetValue(f, out var v) ? v : "other";
        string Grp(string f) => fileNs.TryGetValue(f, out var v) ? v : "other";

        // contexts + namespaces (colours from deterministic palettes, sorted name)
        var usedCtx = files.Select(Ctx).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList();
        var usedNs = files.Select(Grp).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList();
        var ctxColourMap = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int i = 0; i < usedCtx.Count; i++) ctxColourMap[usedCtx[i]] = CtxPalette[i % CtxPalette.Length];
        var nsColourMap = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int i = 0; i < usedNs.Count; i++) nsColourMap[usedNs[i]] = NsPalette[i % NsPalette.Length];

        // file-level SCCs
        var fAdj = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var f in files) fAdj[f] = new();
        foreach (var (a, b) in edges) fAdj[a].Add(b);
        var fileScc = Scc.Of(files, fAdj);

        // namespace-level SCCs
        var allGroups = Seq.DistinctInOrder(files.Select(Grp));
        var gAdj = BuildClusterAdj(allGroups, edges, Grp);
        var groupScc = Scc.Of(allGroups, gAdj);

        // context-level SCCs
        var allCtx = Seq.DistinctInOrder(files.Select(Ctx));
        var cAdj = BuildClusterAdj(allCtx, edges, Ctx);
        var ctxScc = Scc.Of(allCtx, cAdj);

        // namespace → its files
        var byGroup = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var f in files)
        {
            string g = Grp(f);
            if (!byGroup.TryGetValue(g, out var l)) { l = new(); byGroup[g] = l; }
            l.Add(f);
        }

        return new Model
        {
            Files = files,
            Edges = edges,
            FileScc = fileScc,
            GroupScc = groupScc,
            CtxScc = ctxScc,
            AllGroups = allGroups,
            AllCtx = allCtx,
            ByGroup = byGroup,
            FileCtx = fileCtx,
            FileNs = fileNs,
            CtxColourMap = ctxColourMap,
            NsColourMap = nsColourMap,
            ContextOrder = usedCtx,
            TpPackages = tpPkgs.OrderBy(x => x, StringComparer.Ordinal).ToList(),
            TpEdges = tpEdges,
            TypeXctxEdges = typeXctxEdges,
        };
    }

    private static Dictionary<string, List<string>> BuildClusterAdj(
        List<string> clusters, List<(string a, string b)> edges, Func<string, string> of)
    {
        var sets = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var adj = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var g in clusters) { sets[g] = new(StringComparer.Ordinal); adj[g] = new(); }
        foreach (var (a, b) in edges)
        {
            string ga = of(a), gb = of(b);
            if (ga != gb && sets[ga].Add(gb)) adj[ga].Add(gb);
        }
        return adj;
    }
}
