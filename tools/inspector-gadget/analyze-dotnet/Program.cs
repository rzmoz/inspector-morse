using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using InspectorGadget.Dotnet;

// .NET helper entry: parse <code-root>, run the analyzer, write RAW JSON to
// stdout for the node orchestrator to consume. stderr carries warnings.
//
// Stack-bound DFS hazard (IL walk + type-ref recursion) → run on a 256 MB worker.
//
// WIRE: stdout JSON keys = { files, fileCtx, fileNs, edges, tpEdges, tpPkgs,
// typeXctxEdges } — same shape analyze-ts.mjs produces; mergeRaw() concatenates.

try { Console.OutputEncoding = new UTF8Encoding(false); } catch { /* redirected */ }

if (args.Length < 1 || args[0] == "-h" || args[0] == "--help")
{
    Console.Error.Write("usage: analyze-dotnet <code-root>\n");
    return args.Length < 1 ? 1 : 0;
}

string root = args[0];
int code = 0;
var jsonOpts = new JsonSerializerOptions
{
    Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    WriteIndented = false,
};
var worker = new Thread(() =>
{
    try
    {
        var raw = Analyzer.Build(root, Analyzer.DefaultExcludes);
        var json = JsonSerializer.Serialize(raw, jsonOpts);
        Console.Out.Write(json);
    }
    catch (Exception e) { Console.Error.Write($"error: {e.Message}\n"); code = 1; }
}, 256 * 1024 * 1024);
worker.Start();
worker.Join();
return code;
