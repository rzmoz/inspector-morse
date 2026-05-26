namespace InspectorMorse.Core;

// The ecosystem-agnostic dependency model — the single shared definition of "the
// codebase" that every analyzer (Node today, .NET later) produces and that the
// Viewer renders. Nothing here knows about TypeScript: it is just contexts,
// namespaces, files, import edges, per-level SCCs, and third-party references.
internal sealed class Model
{
    public required List<string> Files;
    public required List<(string a, string b)> Edges;
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
    public required List<(string f, string pkg)> TpEdges;
    public required List<(string a, string b)> TypeXctxEdges;

    public string ContextOf(string f) => FileCtx.TryGetValue(f, out var v) ? v : "other";
    public string GroupOf(string f) => FileNs.TryGetValue(f, out var v) ? v : "other";
    public string CtxColour(string n) => CtxColourMap.TryGetValue(n, out var v) ? v : "#ffffff";
    public string ColourOf(string g) => NsColourMap.TryGetValue(g, out var v) ? v : "#ffffff";
}
