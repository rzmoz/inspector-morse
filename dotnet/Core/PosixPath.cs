namespace InspectorMorse.Core;

// Faithful port of Node's `path.posix` normalize/join/dirname. Analyzers key
// everything by repo-root-relative POSIX paths and resolve with these, so the
// resolution math is identical regardless of the host platform's separator.
internal static class PosixPath
{
    private const char Slash = '/';
    private const char Dot = '.';

    private static string NormalizeString(string path, bool allowAboveRoot)
    {
        var res = "";
        int lastSegmentLength = 0, lastSlash = -1, dots = 0, code = 0;
        for (int i = 0; i <= path.Length; i++)
        {
            if (i < path.Length) code = path[i];
            else if (code == Slash) break;
            else code = Slash;

            if (code == Slash)
            {
                if (lastSlash == i - 1 || dots == 1)
                {
                    // no-op: empty segment or '.'
                }
                else if (dots == 2)
                {
                    if (res.Length < 2 || lastSegmentLength != 2 ||
                        res[^1] != Dot || res[^2] != Dot)
                    {
                        if (res.Length > 2)
                        {
                            int lastSlashIndex = res.LastIndexOf(Slash);
                            if (lastSlashIndex == -1) { res = ""; lastSegmentLength = 0; }
                            else { res = res[..lastSlashIndex]; lastSegmentLength = res.Length - 1 - res.LastIndexOf(Slash); }
                            lastSlash = i; dots = 0; continue;
                        }
                        else if (res.Length != 0)
                        {
                            res = ""; lastSegmentLength = 0; lastSlash = i; dots = 0; continue;
                        }
                    }
                    if (allowAboveRoot)
                    {
                        res += res.Length > 0 ? "/.." : "..";
                        lastSegmentLength = 2;
                    }
                }
                else
                {
                    string seg = path.Substring(lastSlash + 1, i - (lastSlash + 1));
                    res = res.Length > 0 ? res + "/" + seg : seg;
                    lastSegmentLength = i - lastSlash - 1;
                }
                lastSlash = i;
                dots = 0;
            }
            else if (code == Dot && dots != -1) { dots++; }
            else { dots = -1; }
        }
        return res;
    }

    public static string Normalize(string path)
    {
        if (path.Length == 0) return ".";
        bool isAbsolute = path[0] == Slash;
        bool trailing = path[^1] == Slash;
        path = NormalizeString(path, !isAbsolute);
        if (path.Length == 0)
        {
            if (isAbsolute) return "/";
            return trailing ? "./" : ".";
        }
        if (trailing) path += "/";
        return isAbsolute ? "/" + path : path;
    }

    public static string Join(params string[] args)
    {
        if (args.Length == 0) return ".";
        string? joined = null;
        foreach (var arg in args)
        {
            if (arg.Length > 0)
                joined = joined == null ? arg : joined + "/" + arg;
        }
        return joined == null ? "." : Normalize(joined);
    }

    public static string Dirname(string path)
    {
        if (path.Length == 0) return ".";
        bool hasRoot = path[0] == Slash;
        int end = -1;
        bool matchedSlash = true;
        for (int i = path.Length - 1; i >= 1; i--)
        {
            if (path[i] == Slash) { if (!matchedSlash) { end = i; break; } }
            else matchedSlash = false;
        }
        if (end == -1) return hasRoot ? "/" : ".";
        if (hasRoot && end == 1) return "//";
        return path[..end];
    }
}
