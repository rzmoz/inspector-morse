namespace InspectorGadget.Core;

// Run config. Only Exclude is analyzer-supplied; Title = root dir name,
// OutputDsm = <root>/codebase-dsm.html.
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
