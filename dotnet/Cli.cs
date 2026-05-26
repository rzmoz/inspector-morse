namespace InspectorMorse;

// Generic CLI parsing — ecosystem-agnostic. Parses the chosen ecosystem command
// (node|dotnet), the help flag, and the raw --code-root; validation + dispatch
// to an ecosystem analyzer happens in Program.cs. There is no config file.
internal sealed record Cli(string? Command, bool Help, string? Root)
{
    public const string Usage =
        "usage: inspector-morse <node|dotnet> --code-root <dir> [-h|--help]\n" +
        "\n" +
        "  <node|dotnet>   target ecosystem to inspect\n" +
        "                    node    TypeScript/Node project (.d.ts always included)\n" +
        "                    dotnet  not implemented\n" +
        "  --code-root <dir>    project root to scan (required)\n" +
        "  -h, --help      show this help and exit\n" +
        "\n" +
        "Writes codebase-dsm.html into <dir>; the page title is the root dir name.";

    public static Cli Parse(string[] argv)
    {
        bool help = false;
        string? codeRoot = null;
        var positionals = new List<string>();

        for (int i = 0; i < argv.Length; i++)
        {
            var a = argv[i];
            if (a == "-h" || a == "--help") { help = true; continue; }
            if (a == "--code-root")
            {
                if (i + 1 >= argv.Length) throw new ArgumentException("Option '--code-root <value>' argument missing");
                codeRoot = argv[++i];
                continue;
            }
            if (a.StartsWith("--code-root=", StringComparison.Ordinal)) { codeRoot = a["--code-root=".Length..]; continue; }
            if (a.Length > 1 && a[0] == '-') throw new ArgumentException($"Unknown option '{a}'");
            positionals.Add(a);
        }

        return new Cli(positionals.Count > 0 ? positionals[0] : null, help, codeRoot);
    }
}
