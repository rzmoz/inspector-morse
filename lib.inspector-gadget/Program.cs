using System.Text;
using InspectorGadget;
using InspectorGadget.Core;
using InspectorGadget.Analyzer;

// CLI entry + ecosystem dispatch: validate args, run the chosen analyzer, render.

// report glyphs need UTF-8; ignore if it can't be set (redirected console)
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
// large-stack worker: the Tarjan/reachability recursion can overflow the default stack.
var worker = new Thread(() =>
{
    try
    {
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
