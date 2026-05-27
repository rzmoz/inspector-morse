using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Xml.Linq;
using InspectorGadget.Core;

namespace InspectorGadget.Analyzer;

// .NET analyzer: reads the target's COMPILED assemblies via
// System.Reflection.Metadata (BCL-only) → Core.Model. NDepend-style: context =
// assembly, namespace = C# namespace, leaf = type, edge = type→type (structural +
// method-body IL). First-party from .csproj+bin; every other referenced assembly
// (incl. System.*/Microsoft.*) is third-party. Build the target first.
internal static class DotnetAnalyzer
{
    // dirs skipped when searching for .csproj (dot-dirs too)
    public static readonly string[] DefaultExcludes = { "bin", "obj", "node_modules" };

    // (assembly, fully-qualified type name) — a type's cross-assembly identity.
    private readonly record struct TypeId(string Assembly, string FullName);
    // where a first-party type lives: which loaded reader + its metadata handle.
    private readonly record struct TypeLoc(int ReaderIdx, TypeDefinitionHandle Handle);

    public static Model Build(Config config)
    {
        string root = config.Root;
        var exclude = new HashSet<string>(config.Exclude, StringComparer.Ordinal);

        // discover first-party assemblies from .csproj layout + bin output
        var csprojs = new List<string>();
        FindCsproj(root, exclude, csprojs);
        csprojs.Sort(StringComparer.Ordinal);

        var firstPartyDlls = new List<(string asm, string dll)>();
        var asmSeen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var cs in csprojs)
        {
            string asm = AsmName(cs);
            string? dll = FindDll(Path.GetDirectoryName(cs)!, asm);
            if (dll == null)
            {
                Console.Error.Write($"warning: no built assembly found for project '{asm}' (build the target first)\n");
                continue;
            }
            if (asmSeen.Add(asm)) firstPartyDlls.Add((asm, dll));
        }
        if (firstPartyDlls.Count == 0)
            throw new Exception($"no built assemblies found under {root} — build the target first (e.g. `dotnet build`)");

        var streams = new List<FileStream>();
        var pes = new List<PEReader>();
        var readers = new List<MetadataReader>();
        var ctxNames = new List<string>();
        try
        {
            // pass 1: enumerate types → leaf nodes + resolution index
            var files = new List<string>();
            var fileCtx = new Dictionary<string, string>(StringComparer.Ordinal);
            var fileNs = new Dictionary<string, string>(StringComparer.Ordinal);
            var index = new Dictionary<TypeId, string>(); // type identity → leafId
            var typeOf = new Dictionary<string, TypeLoc>(StringComparer.Ordinal);
            var firstParty = new HashSet<string>(StringComparer.Ordinal);

            foreach (var (asm, dll) in firstPartyDlls)
            {
                FileStream fs; PEReader pe; MetadataReader r;
                try
                {
                    fs = new FileStream(dll, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    pe = new PEReader(fs);
                    r = pe.GetMetadataReader();
                }
                catch { continue; }

                string ctx;
                try { ctx = r.GetString(r.GetAssemblyDefinition().Name); }
                catch { ctx = asm; }
                if (string.IsNullOrEmpty(ctx)) ctx = asm;

                streams.Add(fs); pes.Add(pe); readers.Add(r); ctxNames.Add(ctx);
                int myIdx = readers.Count - 1;
                firstParty.Add(ctx);

                foreach (var th in r.TypeDefinitions)
                {
                    var td = r.GetTypeDefinition(th);
                    string name = r.GetString(td.Name);
                    if (name.Length == 0 || name.IndexOf('<') >= 0) continue; // <Module>, compiler-generated
                    var (ns, full) = TypeName(r, th);
                    if (full.IndexOf('<') >= 0) continue; // nested compiler-generated
                    string nsLabel = ns.Length > 0 ? ns : "(root)";
                    string typeLocal = ns.Length > 0 && full.StartsWith(ns + ".", StringComparison.Ordinal)
                        ? full[(ns.Length + 1)..] : full;
                    string leaf = ctx + "/" + nsLabel + "/" + typeLocal;
                    if (typeOf.ContainsKey(leaf)) continue;
                    files.Add(leaf);
                    fileCtx[leaf] = ctx;
                    fileNs[leaf] = ctx + Model.NsSep + nsLabel;
                    index[new TypeId(ctx, full)] = leaf;
                    typeOf[leaf] = new TypeLoc(myIdx, th);
                }
            }
            files.Sort(StringComparer.Ordinal); // deterministic order

            // pass 2: type→type edges (structural + IL bodies)
            var edges = new List<Edge>();
            var edgeSeen = new HashSet<Edge>();
            var tpEdges = new List<TpRef>();
            var tpSeen = new HashSet<TpRef>();
            var tpPkgs = new HashSet<string>(StringComparer.Ordinal);

            foreach (var leaf in files)
            {
                var (readerIdx, typeHandle) = typeOf[leaf];
                var reader = readers[readerIdx]; var peReader = pes[readerIdx]; var ctx = ctxNames[readerIdx];
                var ids = new List<TypeId>();
                var idSeen = new HashSet<TypeId>();
                try { CollectTypeRefs(reader, peReader, ctx, typeHandle, ids, idSeen); }
                catch { /* skip malformed type */ }

                foreach (var id in ids)
                {
                    if (index.TryGetValue(id, out var tleaf))
                    {
                        var e = new Edge(leaf, tleaf);
                        if (tleaf != leaf && edgeSeen.Add(e)) edges.Add(e);
                    }
                    else if (!firstParty.Contains(id.Assembly)) // external assembly → third-party
                    {
                        tpPkgs.Add(id.Assembly);
                        var t = new TpRef(leaf, id.Assembly);
                        if (tpSeen.Add(t)) tpEdges.Add(t);
                    }
                    // else: first-party assembly but type was skipped → no edge
                }
            }

            return ModelBuilder.Assemble(files, fileCtx, fileNs, edges, tpEdges, tpPkgs, new List<Edge>());
        }
        finally
        {
            foreach (var pe in pes) pe.Dispose();
            foreach (var fs in streams) fs.Dispose();
        }
    }

    // discovery helpers
    private static void FindCsproj(string dir, HashSet<string> exclude, List<string> outp)
    {
        string[] entries;
        try { entries = Directory.GetFileSystemEntries(dir); }
        catch { return; }
        foreach (var p in entries)
        {
            string name = Path.GetFileName(p);
            if (Directory.Exists(p))
            {
                if (name.StartsWith('.') || exclude.Contains(name)) continue;
                FindCsproj(p, exclude, outp);
            }
            else if (name.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            {
                outp.Add(p);
            }
        }
    }

    private static string AsmName(string csproj)
    {
        try
        {
            var doc = XDocument.Load(csproj);
            var an = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "AssemblyName")?.Value;
            if (!string.IsNullOrWhiteSpace(an) && !an.Contains('$')) return an.Trim();
        }
        catch { /* fall through */ }
        return Path.GetFileNameWithoutExtension(csproj);
    }

    private static string? FindDll(string projDir, string asm)
    {
        string bin = Path.Combine(projDir, "bin");
        if (!Directory.Exists(bin)) return null;
        string[] cands;
        try { cands = Directory.GetFiles(bin, asm + ".dll", SearchOption.AllDirectories); }
        catch { return null; }
        return cands
            .Where(p => { var u = p.Replace('\\', '/'); return !u.Contains("/ref/") && !u.Contains("/refint/"); })
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();
    }

    // type identity
    private static (string ns, string full) TypeName(MetadataReader r, TypeDefinitionHandle h)
    {
        var td = r.GetTypeDefinition(h);
        string name = r.GetString(td.Name);
        var decl = td.GetDeclaringType();
        if (decl.IsNil)
        {
            string ns = r.GetString(td.Namespace);
            return (ns, ns.Length > 0 ? ns + "." + name : name);
        }
        var (pns, pfull) = TypeName(r, decl);
        return (pns, pfull + "+" + name);
    }

    private static TypeId ResolveTypeRef(MetadataReader r, string ctx, TypeReferenceHandle h)
    {
        var tr = r.GetTypeReference(h);
        string name = r.GetString(tr.Name);
        var scope = tr.ResolutionScope;
        if (scope.Kind == HandleKind.AssemblyReference)
        {
            string asm = r.GetString(r.GetAssemblyReference((AssemblyReferenceHandle)scope).Name);
            string ns = r.GetString(tr.Namespace);
            return new TypeId(asm, ns.Length > 0 ? ns + "." + name : name);
        }
        if (scope.Kind == HandleKind.TypeReference)
        {
            var (pasm, pfull) = ResolveTypeRef(r, ctx, (TypeReferenceHandle)scope);
            return new TypeId(pasm, pfull + "+" + name);
        }
        // ModuleDefinition / ModuleReference / nil → current assembly
        {
            string ns = r.GetString(tr.Namespace);
            return new TypeId(ctx, ns.Length > 0 ? ns + "." + name : name);
        }
    }

    // collect every type a given type depends on
    private static void CollectTypeRefs(MetadataReader r, PEReader pe, string ctx,
        TypeDefinitionHandle th, List<TypeId> ids, HashSet<TypeId> seen)
    {
        var td = r.GetTypeDefinition(th);
        void Add(EntityHandle e) { if (!e.IsNil) Resolve(r, ctx, e, ids, seen); }

        if (!td.BaseType.IsNil) Add(td.BaseType);
        foreach (var ih in td.GetInterfaceImplementations()) Add(r.GetInterfaceImplementation(ih).Interface);
        AddGenericConstraints(r, ctx, td.GetGenericParameters(), ids, seen);
        foreach (var ca in td.GetCustomAttributes()) Add(r.GetCustomAttribute(ca).Constructor);

        foreach (var fhh in td.GetFields())
        {
            var fd = r.GetFieldDefinition(fhh);
            DecodeInto(ids, seen, r, ctx, c => fd.DecodeSignature(c, null));
            foreach (var ca in fd.GetCustomAttributes()) Add(r.GetCustomAttribute(ca).Constructor);
        }
        foreach (var ph in td.GetProperties())
        {
            var pd = r.GetPropertyDefinition(ph);
            DecodeInto(ids, seen, r, ctx, c => pd.DecodeSignature(c, null));
        }
        foreach (var mh in td.GetMethods())
        {
            var md = r.GetMethodDefinition(mh);
            DecodeInto(ids, seen, r, ctx, c => md.DecodeSignature(c, null));
            AddGenericConstraints(r, ctx, md.GetGenericParameters(), ids, seen);
            foreach (var ca in md.GetCustomAttributes()) Add(r.GetCustomAttribute(ca).Constructor);

            if (md.RelativeVirtualAddress != 0)
            {
                try
                {
                    var body = pe.GetMethodBody(md.RelativeVirtualAddress);
                    if (!body.LocalSignature.IsNil)
                        DecodeInto(ids, seen, r, ctx, c => r.GetStandaloneSignature(body.LocalSignature).DecodeLocalSignature(c, null));
                    foreach (var er in body.ExceptionRegions)
                        if (er.Kind == ExceptionRegionKind.Catch && !er.CatchType.IsNil) Add(er.CatchType);
                    var il = body.GetILBytes();
                    if (il != null) WalkIL(il, r, ctx, ids, seen);
                }
                catch { /* unreadable body */ }
            }
        }
    }

    private static void AddGenericConstraints(MetadataReader r, string ctx,
        GenericParameterHandleCollection gps, List<TypeId> ids, HashSet<TypeId> seen)
    {
        foreach (var gph in gps)
        {
            var gp = r.GetGenericParameter(gph);
            foreach (var ch in gp.GetConstraints())
            {
                var t = r.GetGenericParameterConstraint(ch).Type;
                if (!t.IsNil) Resolve(r, ctx, t, ids, seen);
            }
        }
    }

    // decode a signature through the collector, then resolve each handle it recorded
    private static void DecodeInto(List<TypeId> ids, HashSet<TypeId> seen,
        MetadataReader r, string ctx, Action<RefCollector> decode)
    {
        var col = new RefCollector();
        try { decode(col); } catch { return; }
        foreach (var h in col.Handles) Resolve(r, ctx, h, ids, seen);
    }

    private static void Resolve(MetadataReader r, string ctx, EntityHandle h,
        List<TypeId> ids, HashSet<TypeId> seen)
    {
        if (h.IsNil) return;
        switch (h.Kind)
        {
            case HandleKind.TypeDefinition:
            {
                var (_, full) = TypeName(r, (TypeDefinitionHandle)h);
                AddId(ctx, full, ids, seen);
                break;
            }
            case HandleKind.TypeReference:
            {
                var (asm, full) = ResolveTypeRef(r, ctx, (TypeReferenceHandle)h);
                AddId(asm, full, ids, seen);
                break;
            }
            case HandleKind.TypeSpecification:
            {
                var col = new RefCollector();
                try { r.GetTypeSpecification((TypeSpecificationHandle)h).DecodeSignature(col, null); } catch { break; }
                foreach (var hh in col.Handles) Resolve(r, ctx, hh, ids, seen);
                break;
            }
            case HandleKind.MemberReference:
                Resolve(r, ctx, r.GetMemberReference((MemberReferenceHandle)h).Parent, ids, seen);
                break;
            case HandleKind.MethodDefinition:
                Resolve(r, ctx, r.GetMethodDefinition((MethodDefinitionHandle)h).GetDeclaringType(), ids, seen);
                break;
            case HandleKind.FieldDefinition:
                Resolve(r, ctx, r.GetFieldDefinition((FieldDefinitionHandle)h).GetDeclaringType(), ids, seen);
                break;
            case HandleKind.MethodSpecification:
            {
                var ms = r.GetMethodSpecification((MethodSpecificationHandle)h);
                Resolve(r, ctx, ms.Method, ids, seen);
                var col = new RefCollector();
                try { ms.DecodeSignature(col, null); } catch { break; }
                foreach (var hh in col.Handles) Resolve(r, ctx, hh, ids, seen);
                break;
            }
            case HandleKind.StandaloneSignature:
            {
                var col = new RefCollector();
                try { r.GetStandaloneSignature((StandaloneSignatureHandle)h).DecodeMethodSignature(col, null); } catch { break; }
                foreach (var hh in col.Handles) Resolve(r, ctx, hh, ids, seen);
                break;
            }
        }
    }

    private static void AddId(string asm, string full, List<TypeId> ids, HashSet<TypeId> seen)
    {
        var id = new TypeId(asm, full);
        if (seen.Add(id)) ids.Add(id);
    }

    // IL body walk: referenced types from token-bearing opcodes
    private static readonly Dictionary<short, OperandType> OpTable = BuildOpTable();

    private static Dictionary<short, OperandType> BuildOpTable()
    {
        var d = new Dictionary<short, OperandType>();
        foreach (var f in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            if (f.FieldType == typeof(OpCode))
            {
                var oc = (OpCode)f.GetValue(null)!;
                d[oc.Value] = oc.OperandType;
            }
        }
        return d;
    }

    private static void WalkIL(byte[] il, MetadataReader r, string ctx,
        List<TypeId> ids, HashSet<TypeId> seen)
    {
        int i = 0, n = il.Length;
        while (i < n)
        {
            short op;
            byte b = il[i++];
            if (b == 0xFE) { if (i >= n) break; op = unchecked((short)(0xFE00 | il[i++])); }
            else op = b;
            if (!OpTable.TryGetValue(op, out var ot)) break;

            switch (ot)
            {
                case OperandType.InlineNone: break;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar: i += 1; break;
                case OperandType.InlineVar: i += 2; break;
                case OperandType.ShortInlineR:
                case OperandType.InlineBrTarget:
                case OperandType.InlineI: i += 4; break;
                case OperandType.InlineI8:
                case OperandType.InlineR: i += 8; break;
                case OperandType.InlineString: i += 4; break; // user string, not a type
                case OperandType.InlineField:
                case OperandType.InlineMethod:
                case OperandType.InlineType:
                case OperandType.InlineTok:
                case OperandType.InlineSig:
                {
                    if (i + 4 > n) return;
                    int tok = il[i] | (il[i + 1] << 8) | (il[i + 2] << 16) | (il[i + 3] << 24);
                    i += 4;
                    if (tok != 0)
                    {
                        try { Resolve(r, ctx, MetadataTokens.EntityHandle(tok), ids, seen); }
                        catch { /* string/invalid token */ }
                    }
                    break;
                }
                case OperandType.InlineSwitch:
                {
                    if (i + 4 > n) return;
                    int cnt = il[i] | (il[i + 1] << 8) | (il[i + 2] << 16) | (il[i + 3] << 24);
                    i += 4 + 4 * cnt;
                    break;
                }
                default: return; // unknown/obsolete operand shape → stop defensively
            }
        }
    }

    // ISignatureTypeProvider that just records leaf type handles (TType unused)
    private sealed class RefCollector : ISignatureTypeProvider<int, object?>
    {
        public readonly List<EntityHandle> Handles = new();
        public int GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) { Handles.Add(handle); return 0; }
        public int GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind) { Handles.Add(handle); return 0; }
        public int GetTypeFromSpecification(MetadataReader reader, object? genericContext, TypeSpecificationHandle handle, byte rawTypeKind) { Handles.Add(handle); return 0; }
        public int GetPrimitiveType(PrimitiveTypeCode typeCode) => 0;
        public int GetSZArrayType(int elementType) => 0;
        public int GetArrayType(int elementType, ArrayShape shape) => 0;
        public int GetByReferenceType(int elementType) => 0;
        public int GetPointerType(int elementType) => 0;
        public int GetGenericInstantiation(int genericType, ImmutableArray<int> typeArguments) => 0;
        public int GetGenericMethodParameter(object? genericContext, int index) => 0;
        public int GetGenericTypeParameter(object? genericContext, int index) => 0;
        public int GetFunctionPointerType(MethodSignature<int> signature) => 0;
        public int GetModifiedType(int modifier, int unmodifiedType, bool isRequired) => 0;
        public int GetPinnedType(int elementType) => 0;
    }
}
