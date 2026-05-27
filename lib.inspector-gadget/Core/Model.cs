namespace InspectorGadget.Core;

// a dependency between two leaf nodes (file/type ids); value equality dedups
internal readonly record struct Edge(string From, string To);
// a leaf's reference to a third-party package / external assembly
internal readonly record struct TpRef(string From, string Package);

// the shared, language-agnostic dependency model: contexts, namespaces, files,
// edges, per-level SCCs, third-party refs. Analyzers produce it; Viewer renders it.
internal sealed class Model
{
    // namespace labels are "{ctx}{NsSep}{name}" (analyzers build, viewer splits on NsSep)
    public const string NsSep = " · ";

    public required List<string> Files;
    public required List<Edge> Edges;
    public required Scc<string> FileScc;
    public required Scc<string> GroupScc;
    public required Scc<string> CtxScc;
    public required List<string> AllGroups;
    public required List<string> AllCtx;
    public required Dictionary<string, List<string>> ByGroup;
    public required Dictionary<string, string> FileCtx;
    public required Dictionary<string, string> FileNs;
    public required Dictionary<string, string> CtxColourMap;
    public required Dictionary<string, string> NsColourMap;
    public required List<string> ContextOrder; // usedCtx (sorted)
    public required List<string> TpPackages;
    public required List<TpRef> TpEdges;
    public required List<Edge> TypeXctxEdges;

    public string ContextOf(string f) => FileCtx.TryGetValue(f, out var v) ? v : "other";
    public string GroupOf(string f) => FileNs.TryGetValue(f, out var v) ? v : "other";
    public string CtxColour(string n) => CtxColourMap.TryGetValue(n, out var v) ? v : "#ffffff";
    public string ColourOf(string g) => NsColourMap.TryGetValue(g, out var v) ? v : "#ffffff";
}
