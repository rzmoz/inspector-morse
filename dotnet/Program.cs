using System.Text;
using InspectorMorse;
using InspectorMorse.Core;
using InspectorMorse.Node;
using InspectorMorse.Dotnet;

// inspector-morse CLI entry + ecosystem dispatch. Inspects a codebase and writes
// a self-contained codebase-dsm.html (Matrix + Graph tabs) into the target root.
//
//   inspector-morse <node|dotnet> --code-root <dir> [-h|--help]
//
// The Core/ assembly is ecosystem-agnostic (Model + Viewer); each ecosystem
// (Node today, .NET later) plugs in its own analyzer that produces a Core.Model.
// No config file: every setting comes from CLI args + built-in defaults.

// Glyphs in the report (✓ • —) need a UTF-8 console; harmless if it can't be set.
try { Console.OutputEncoding = new UTF8Encoding(false); } catch { /* redirected */ }

static void Err(string s) => Console.Error.Write(s + "\n");
static void Std(string s) => Console.Out.Write(s + "\n");

Cli cli;
try { cli = Cli.Parse(args); }
catch (Exception e) { Err($"error: {e.Message}\n\n{Cli.Usage}"); return 1; }

if (cli.Help) { Std(Cli.Usage); return 0; }
if (cli.Command is null) { Err($"error: missing target ecosystem (node|dotnet)\n\n{Cli.Usage}"); return 1; }
if (cli.Command is not ("node" or "dotnet")) { Err($"error: unknown target \"{cli.Command}\" (expected node|dotnet)\n\n{Cli.Usage}"); return 1; }
if (cli.Root is null) { Err($"error: --code-root <dir> is required\n\n{Cli.Usage}"); return 1; }

string root = cli.Root;
string command = cli.Command;
int code = 0;
// The analysis recurses (Tarjan SCC, reachability DFS); run on a large-stack
// worker so deep dependency chains can't overflow on any platform.
var worker = new Thread(() =>
{
    try
    {
        // each ecosystem analyzer produces the shared Core.Model; the generic
        // renderer turns it into the viewer.
        Config config; Model model;
        if (command == "node")
        {
            config = Config.For(root, NodeAnalyzer.DefaultExcludes);
            model = NodeAnalyzer.Build(config);
        }
        else // "dotnet"
        {
            config = Config.For(root, DotnetAnalyzer.DefaultExcludes);
            model = DotnetAnalyzer.Build(config);
        }
        Viewer.Render(model, config);
    }
    catch (Exception e) { Err($"error: {e.Message}"); code = 1; }
}, 256 * 1024 * 1024);
worker.Start();
worker.Join();
return code;
