using System.Reflection;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace InspectorMorse.Core;

// Ecosystem-agnostic viewer: renders any Model into the self-contained
// codebase-dsm.html (Matrix + Graph tabs) and prints the directionality report.
// Computes the dependency-first ("triangular") sibling order per level, builds
// the context→namespace→file tree + file-indexed edge list (matrix) and the
// graph payload, then fills the HTML template with the embedded client
// renderers + Cytoscape/fcose. Knows nothing about TypeScript.
internal static class Viewer
{
    public static void Render(Model model, Config config)
    {
        var ctxOrderIdx = TriOrder(model.AllCtx, model.ContextOf, model.CtxScc, n => n, n => n, model.Edges);
        var nsOrderIdx = TriOrder(model.AllGroups, model.GroupOf, model.GroupScc, n => n,
            g => model.ContextOf(model.ByGroup[g][0]), model.Edges);
        var fileOrderIdx = TriOrder(model.Files, f => f, model.FileScc, FileLabel, model.ContextOf, model.Edges);

        var payload = BuildPayload(model, ctxOrderIdx, nsOrderIdx, fileOrderIdx);
        string html = AssembleHtml(config.Title, payload);

        File.WriteAllText(config.OutputDsm, html, new UTF8Encoding(false));

        PrintReport(model, config.OutputDsm, html.Length);
    }

    private static string FileLabel(string f)
    {
        var parts = f.Split('/');
        return parts.Length <= 2 ? f : string.Join("/", parts[^2..]);
    }

    // ---- dependency-first ("triangular") sibling order for one level ----
    private static int[] TriOrder(List<string> nodes, Func<string, string> nodeOf, Scc<string> scc,
        Func<string, string> labelFor, Func<string, string> ctxFor, List<(string a, string b)> edges)
    {
        int N = nodes.Count;
        var pos = new Dictionary<string, int>(StringComparer.Ordinal);
        for (int i = 0; i < N; i++) pos[nodes[i]] = i;
        var label = new string[N];
        var ctx = new string[N];
        for (int i = 0; i < N; i++) { label[i] = labelFor(nodes[i]); ctx[i] = ctxFor(nodes[i]); }

        var adj = new OrderedIntSet[N];
        for (int i = 0; i < N; i++) adj[i] = new();
        foreach (var (a, b) in edges)
        {
            if (!pos.TryGetValue(nodeOf(a), out int i)) continue;
            if (!pos.TryGetValue(nodeOf(b), out int j)) continue;
            if (i == j) continue;
            adj[i].Add(j);
        }

        int Comp(int i) => scc.Id[nodes[i]];
        int ncomp = scc.Comps.Count;
        var cadj = new OrderedIntSet[ncomp];
        for (int c = 0; c < ncomp; c++) cadj[c] = new();
        for (int i = 0; i < N; i++)
            foreach (int j in adj[i].Items) { int a = Comp(i), b = Comp(j); if (a != b) cadj[a].Add(b); }

        var compMin = new string?[ncomp];
        for (int i = 0; i < N; i++)
        {
            int c = Comp(i);
            if (compMin[c] == null || string.CompareOrdinal(label[i], compMin[c]) < 0) compMin[c] = label[i];
        }

        // localeCompare → InvariantCulture; JS Array.sort is stable → LINQ OrderBy.
        var inv = StringComparer.InvariantCulture;
        var visited = new HashSet<int>();
        var post = new List<int>();
        void Dfs(int c)
        {
            visited.Add(c);
            foreach (int d in cadj[c].Items.OrderBy(x => compMin[x] ?? "", inv))
                if (!visited.Contains(d)) Dfs(d);
            post.Add(c);
        }
        foreach (int c in Enumerable.Range(0, ncomp).OrderBy(x => compMin[x] ?? "", inv))
            if (!visited.Contains(c)) Dfs(c);

        var members = new List<int>[ncomp];
        for (int c = 0; c < ncomp; c++) members[c] = new();
        for (int i = 0; i < N; i++) members[Comp(i)].Add(i);
        for (int c = 0; c < ncomp; c++) members[c] = members[c].OrderBy(idx => label[idx], inv).ToList();

        var triGlobal = new List<int>();
        foreach (int c in post) triGlobal.AddRange(members[c]);

        // context-major partition (context graph is acyclic) keeps each context
        // one contiguous dependency-first run with its triangular order intact.
        var ctxKeys = Seq.DistinctInOrder(ctx);
        var ctxAdj = new Dictionary<string, OrderedStringSet>(StringComparer.Ordinal);
        foreach (var c in ctxKeys) ctxAdj[c] = new();
        for (int i = 0; i < N; i++)
            foreach (int j in adj[i].Items) if (ctx[i] != ctx[j]) ctxAdj[ctx[i]].Add(ctx[j]);
        var cvis = new HashSet<string>(StringComparer.Ordinal);
        var cpost = new List<string>();
        void Cdfs(string c)
        {
            cvis.Add(c);
            foreach (var d in ctxAdj[c].Items.OrderBy(x => x, StringComparer.Ordinal))
                if (!cvis.Contains(d)) Cdfs(d);
            cpost.Add(c);
        }
        foreach (var c in ctxKeys.OrderBy(x => x, StringComparer.Ordinal)) if (!cvis.Contains(c)) Cdfs(c);

        var order = new List<int>();
        foreach (var c in cpost) foreach (int i in triGlobal) if (ctx[i] == c) order.Add(i);
        return order.ToArray();
    }

    // ---- assemble the single payload object consumed by both client renderers ----
    private static PayloadDto BuildPayload(Model model, int[] ctxOrderIdx, int[] nsOrderIdx, int[] fileOrderIdx)
    {
        var files = model.Files;
        var fIndex = new Dictionary<string, int>(StringComparer.Ordinal);
        for (int i = 0; i < files.Count; i++) fIndex[files[i]] = i;

        var ctxOrder = ctxOrderIdx.Select(i => model.AllCtx[i]).ToList();
        var nsOrderAll = nsOrderIdx.Select(i => model.AllGroups[i]).ToList();
        var fileOrderAll = fileOrderIdx.Select(i => files[i]).ToList();

        var nsByCtx = ctxOrder.ToDictionary(c => c, _ => new List<string>(), StringComparer.Ordinal);
        foreach (var ns in nsOrderAll) nsByCtx[model.ContextOf(model.ByGroup[ns][0])].Add(ns);
        var filesByNs = nsOrderAll.ToDictionary(ns => ns, _ => new List<string>(), StringComparer.Ordinal);
        foreach (var f in fileOrderAll) filesByNs[model.GroupOf(f)].Add(f);

        var nodes = new Dictionary<string, NodeDto>(StringComparer.Ordinal);
        var roots = new List<string>();
        foreach (var c in ctxOrder)
        {
            string cid = "c:" + c;
            var ctxNode = new NodeDto { Id = cid, Kind = "context", Label = c, Title = c, Colour = model.CtxColour(c), Ctx = c, Parent = null, Depth = 0 };
            nodes[cid] = ctxNode; roots.Add(cid);
            foreach (var ns in nsByCtx[c])
            {
                string nid = "n:" + ns;
                var nsNode = new NodeDto { Id = nid, Kind = "namespace", Label = ns, Title = ns, Colour = model.ColourOf(ns), Ctx = c, Parent = cid, Depth = 1 };
                nodes[nid] = nsNode; ctxNode.Children.Add(nid);
                foreach (var f in filesByNs[ns])
                {
                    int fi = fIndex[f]; string fid = "f:" + fi;
                    nodes[fid] = new NodeDto { Id = fid, Kind = "file", Label = FileLabel(f), Title = f, Colour = model.ColourOf(ns), Ctx = c, Parent = nid, Depth = 2, Fi = fi };
                    nsNode.Children.Add(fid);
                }
            }
        }

        var edgeIdx = model.Edges.Select(e => new[] { fIndex[e.a], fIndex[e.b] }).ToList();
        var fileComp = files.Select(f => model.FileScc.Id[f]).ToList();
        var cycleComps = model.FileScc.Comps
            .Select((c, i) => (i, n: c.Count)).Where(x => x.n > 1).Select(x => x.i).ToList();

        var fadj = new List<int>[files.Count];
        for (int i = 0; i < files.Count; i++) fadj[i] = new();
        foreach (var e in edgeIdx) fadj[e[0]].Add(e[1]);
        var reachPairs = new List<int[]>();
        for (int i = 0; i < files.Count; i++)
        {
            var seenSet = new HashSet<int>();
            var seenOrder = new List<int>();
            var st = new List<int>(fadj[i]);
            while (st.Count > 0)
            {
                int x = st[^1]; st.RemoveAt(st.Count - 1);
                if (!seenSet.Add(x)) continue;
                seenOrder.Add(x);
                foreach (int y in fadj[x]) if (!seenSet.Contains(y)) st.Add(y);
            }
            foreach (int j in seenOrder) if (j != i) reachPairs.Add(new[] { i, j });
        }

        var contexts = model.ContextOrder.Where(n => model.AllCtx.Contains(n))
            .Select(n => new ContextDto { Name = n, Colour = model.CtxColour(n) }).ToList();

        // ---- third-party reference nodes (synthetic sink "files") ----
        const string tpCtx = "(third-party)", tpCtxColour = "#e9d5ff", tpNodeColour = "#d8b4fe";
        var packages = model.TpPackages;
        var tpFi = new Dictionary<string, int>(StringComparer.Ordinal);
        for (int i = 0; i < packages.Count; i++) tpFi[packages[i]] = files.Count + i;
        string tpCtxId = "c:" + tpCtx;
        if (packages.Count > 0)
        {
            var tpCtxNode = new NodeDto { Id = tpCtxId, Kind = "context", Label = tpCtx, Title = tpCtx + " — external references", Colour = tpCtxColour, Ctx = tpCtx, Parent = null, Depth = 0, Tp = true };
            nodes[tpCtxId] = tpCtxNode; roots.Add(tpCtxId);
            foreach (var pkg in packages)
            {
                string nid = "n:" + pkg; int fi = tpFi[pkg]; string fid = "f:" + fi;
                var nsNode = new NodeDto { Id = nid, Kind = "namespace", Label = pkg, Title = pkg, Colour = tpNodeColour, Ctx = tpCtx, Parent = tpCtxId, Depth = 1, Tp = true };
                nsNode.Children.Add(fid);
                nodes[nid] = nsNode; tpCtxNode.Children.Add(nid);
                nodes[fid] = new NodeDto { Id = fid, Kind = "file", Label = pkg, Title = pkg, Colour = tpNodeColour, Ctx = tpCtx, Parent = nid, Depth = 2, Fi = fi, Tp = true };
            }
            contexts.Add(new ContextDto { Name = tpCtx, Colour = tpCtxColour });
        }
        var tpEdgeIdx = model.TpEdges.Select(e => new[] { fIndex[e.f], tpFi[e.pkg] }).ToList();

        // ---- graph-tab data (first-party only) ----
        var gCtxOf = model.AllGroups.ToDictionary(g => g, g => model.ContextOf(model.ByGroup[g][0]), StringComparer.Ordinal);
        var gNodes = new List<GraphNodeDto>();
        foreach (var c in model.AllCtx) gNodes.Add(new GraphNodeDto { Id = "c:" + c, Label = c, Kind = "context", Colour = model.CtxColour(c) });
        foreach (var g in model.AllGroups) gNodes.Add(new GraphNodeDto { Id = "n:" + g, Parent = "c:" + gCtxOf[g], Label = g.Split(" · ")[^1], Kind = "namespace", Colour = model.ColourOf(g), Title = g });
        foreach (var f in files) gNodes.Add(new GraphNodeDto { Id = "f:" + fIndex[f], Parent = "n:" + model.GroupOf(f), Label = f.Split('/')[^1], Kind = "file", Colour = model.ColourOf(model.GroupOf(f)), Title = f });

        var gFileEdges = new List<GraphEdgeDto>();
        foreach (var (a, b) in model.Edges)
        {
            string na = model.GroupOf(a), nb = model.GroupOf(b);
            bool nsCyc = na != nb && model.GroupScc.Id[na] == model.GroupScc.Id[nb] && model.GroupScc.Size(na) > 1;
            bool fileCyc = model.FileScc.Id[a] == model.FileScc.Id[b] && model.FileScc.Size(a) > 1;
            gFileEdges.Add(new GraphEdgeDto { S = "f:" + fIndex[a], T = "f:" + fIndex[b], Ns1 = "n:" + na, Ns2 = "n:" + nb, Ctx1 = "c:" + model.ContextOf(a), Ctx2 = "c:" + model.ContextOf(b), NsCyc = nsCyc, FileCyc = fileCyc });
        }
        foreach (var (a, b) in model.TypeXctxEdges)
            gFileEdges.Add(new GraphEdgeDto { S = "f:" + fIndex[a], T = "f:" + fIndex[b], Ns1 = "n:" + model.GroupOf(a), Ns2 = "n:" + model.GroupOf(b), Ctx1 = "c:" + model.ContextOf(a), Ctx2 = "c:" + model.ContextOf(b), NsCyc = false, FileCyc = false });

        return new PayloadDto
        {
            Nodes = nodes,
            Roots = roots,
            Edges = edgeIdx.Concat(tpEdgeIdx).ToList(),
            FilePaths = files.Concat(packages).ToList(),
            FileComp = fileComp,
            CycleComps = cycleComps,
            ReachPairs = reachPairs,
            Contexts = contexts,
            ThirdPartyCtxId = packages.Count > 0 ? tpCtxId : null,
            FileCount = files.Count,
            EdgeCount = model.Edges.Count,
            TpCount = packages.Count,
            Graph = new GraphDto { Nodes = gNodes, FileEdges = gFileEdges },
        };
    }

    // ---- HTML assembly ----
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    private static string AssembleHtml(string title, PayloadDto payload)
    {
        string css = Resource("template.css");
        string template = Resource("template.html");
        string client = Resource("dsm.client.js");
        string graphClient = Resource("graph.client.js");
        string libs = string.Join("\n;\n", new[]
        {
            Resource("cytoscape.min.js"),
            Resource("layout-base.js"),
            Resource("cose-base.js"),
            Resource("cytoscape-fcose.js"),
        });
        string json = JsonSerializer.Serialize(payload, JsonOpts);

        var vals = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["${title}"] = title,
            ["${CSS}"] = css,
            ["${LIBS}"] = libs,
            ["${JSON.stringify(payload)}"] = json,
            ["${CLIENT}"] = client,
            ["${GRAPH_CLIENT}"] = graphClient,
        };
        return Fill(template, vals);
    }

    // Single-pass placeholder substitution so inserted values (which contain
    // their own `${...}` template literals) are never re-scanned.
    private static string Fill(string tpl, Dictionary<string, string> vals)
    {
        var sb = new StringBuilder(tpl.Length + 1_000_000);
        int i = 0;
        while (i < tpl.Length)
        {
            int p = tpl.IndexOf("${", i, StringComparison.Ordinal);
            if (p < 0) { sb.Append(tpl, i, tpl.Length - i); break; }
            sb.Append(tpl, i, p - i);
            int e = tpl.IndexOf('}', p + 2);
            if (e < 0) { sb.Append(tpl, p, tpl.Length - p); break; }
            string tok = tpl.Substring(p, e - p + 1);
            sb.Append(vals.TryGetValue(tok, out var v) ? v : tok);
            i = e + 1;
        }
        return sb.ToString();
    }

    private static string Resource(string name)
    {
        var asm = Assembly.GetExecutingAssembly();
        using var s = asm.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException($"missing embedded resource: {name}");
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    // ---- console: directionality report ----
    private static void PrintReport(Model model, string outPath, int htmlLen)
    {
        void Out(string s) => Console.Out.Write(s + "\n");

        Out($"files: {model.Files.Count} | edges: {model.Edges.Count} | namespaces: {model.AllGroups.Count} | contexts: {model.AllCtx.Count}");

        var fileCycles = model.FileScc.Comps.Where(c => c.Count > 1).ToList();
        var nsCycles = model.GroupScc.Comps.Where(c => c.Count > 1).ToList();
        var ctxCycles = model.CtxScc.Comps.Where(c => c.Count > 1).ToList();

        Out($"\ncontext-level: {(ctxCycles.Count > 0 ? "CYCLE(S) — architecture violation!" : "acyclic ✓")}");
        foreach (var c in ctxCycles) Out("  " + string.Join(" <-> ", c));

        Out($"\nnamespace cycles (not uni-directional): {(nsCycles.Count > 0 ? nsCycles.Count.ToString() : "none ✓")}");
        foreach (var comp in nsCycles) Out("  • " + string.Join("  <->  ", comp));

        Out($"\nfile import cycles: {(fileCycles.Count > 0 ? fileCycles.Count.ToString() : "none ✓")}");
        foreach (var comp in fileCycles) Out("  • " + string.Join("  <->  ", comp));

        long kb = (long)Math.Round(htmlLen / 1024.0, MidpointRounding.AwayFromZero);
        Out($"\nwrote: {outPath} ({kb} KB)  — interactive viewer: Matrix + Graph tabs (open in a browser)");
    }
}

// ---- payload DTOs (property names match the JS object keys the client reads) ----
internal sealed class NodeDto
{
    [JsonPropertyName("id")] public required string Id { get; set; }
    [JsonPropertyName("kind")] public required string Kind { get; set; }
    [JsonPropertyName("label")] public required string Label { get; set; }
    [JsonPropertyName("title")] public required string Title { get; set; }
    [JsonPropertyName("colour")] public required string Colour { get; set; }
    [JsonPropertyName("ctx")] public required string Ctx { get; set; }
    [JsonPropertyName("parent")] public string? Parent { get; set; }
    [JsonPropertyName("children")] public List<string> Children { get; set; } = new();
    [JsonPropertyName("depth")] public int Depth { get; set; }
    [JsonPropertyName("fi")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Fi { get; set; }
    [JsonPropertyName("tp")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? Tp { get; set; }
}

internal sealed class ContextDto
{
    [JsonPropertyName("name")] public required string Name { get; set; }
    [JsonPropertyName("colour")] public required string Colour { get; set; }
}

internal sealed class GraphNodeDto
{
    [JsonPropertyName("id")] public required string Id { get; set; }
    [JsonPropertyName("parent")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Parent { get; set; }
    [JsonPropertyName("label")] public required string Label { get; set; }
    [JsonPropertyName("kind")] public required string Kind { get; set; }
    [JsonPropertyName("colour")] public required string Colour { get; set; }
    [JsonPropertyName("title")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Title { get; set; }
}

internal sealed class GraphEdgeDto
{
    [JsonPropertyName("s")] public required string S { get; set; }
    [JsonPropertyName("t")] public required string T { get; set; }
    [JsonPropertyName("ns1")] public required string Ns1 { get; set; }
    [JsonPropertyName("ns2")] public required string Ns2 { get; set; }
    [JsonPropertyName("ctx1")] public required string Ctx1 { get; set; }
    [JsonPropertyName("ctx2")] public required string Ctx2 { get; set; }
    [JsonPropertyName("nsCyc")] public bool NsCyc { get; set; }
    [JsonPropertyName("fileCyc")] public bool FileCyc { get; set; }
}

internal sealed class GraphDto
{
    [JsonPropertyName("nodes")] public required List<GraphNodeDto> Nodes { get; set; }
    [JsonPropertyName("fileEdges")] public required List<GraphEdgeDto> FileEdges { get; set; }
}

internal sealed class PayloadDto
{
    [JsonPropertyName("nodes")] public required Dictionary<string, NodeDto> Nodes { get; set; }
    [JsonPropertyName("roots")] public required List<string> Roots { get; set; }
    [JsonPropertyName("edges")] public required List<int[]> Edges { get; set; }
    [JsonPropertyName("filePaths")] public required List<string> FilePaths { get; set; }
    [JsonPropertyName("fileComp")] public required List<int> FileComp { get; set; }
    [JsonPropertyName("cycleComps")] public required List<int> CycleComps { get; set; }
    [JsonPropertyName("reachPairs")] public required List<int[]> ReachPairs { get; set; }
    [JsonPropertyName("contexts")] public required List<ContextDto> Contexts { get; set; }
    [JsonPropertyName("thirdPartyCtxId")] public string? ThirdPartyCtxId { get; set; }
    [JsonPropertyName("fileCount")] public int FileCount { get; set; }
    [JsonPropertyName("edgeCount")] public int EdgeCount { get; set; }
    [JsonPropertyName("tpCount")] public int TpCount { get; set; }
    [JsonPropertyName("graph")] public required GraphDto Graph { get; set; }
}
