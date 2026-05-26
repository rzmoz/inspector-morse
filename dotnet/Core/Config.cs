namespace InspectorMorse.Core;

// Ecosystem-agnostic run config. Every ecosystem produces one of these; only the
// `Exclude` list is ecosystem-supplied (see Node/NodeAnalyzer.DefaultExcludes).
// Title = the root dir name, output = <root>/codebase-dsm.html — both generic.
internal sealed record Config(string Root, string[] Exclude, string Title, string OutputDsm)
{
    public static Config For(string root, string[] exclude)
    {
        string abs = Path.GetFullPath(root);
        string baseName = Basename(abs);
        return new Config(
            Root: abs,
            Exclude: exclude,
            Title: baseName.Length > 0 ? baseName : abs,
            OutputDsm: Path.GetFullPath(Path.Combine(abs, "codebase-dsm.html")));
    }

    private static string Basename(string p)
    {
        string t = p.TrimEnd('/', '\\');
        int i = t.LastIndexOfAny(new[] { '/', '\\' });
        return i >= 0 ? t[(i + 1)..] : t;
    }
}
