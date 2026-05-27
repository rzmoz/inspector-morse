namespace InspectorGadget.Core;

// insertion-order-preserving sets — triangular-order tie-breaks depend on it
// (.NET HashSet doesn't promise iteration order).
internal sealed class OrderedIntSet
{
    private readonly HashSet<int> _set = new();
    public readonly List<int> Items = new();
    public void Add(int x) { if (_set.Add(x)) Items.Add(x); }
}

internal sealed class OrderedStringSet
{
    private readonly HashSet<string> _set = new();
    public readonly List<string> Items = new();
    public void Add(string x) { if (_set.Add(x)) Items.Add(x); }
}

internal static class Seq
{
    // Distinct preserving first-seen order (≡ [...new Set(seq)]).
    public static List<string> DistinctInOrder(IEnumerable<string> seq)
    {
        var s = new HashSet<string>(StringComparer.Ordinal);
        var o = new List<string>();
        foreach (var x in seq) if (s.Add(x)) o.Add(x);
        return o;
    }
}

internal sealed class Scc<T> where T : notnull
{
    public readonly List<List<T>> Comps = new();
    public readonly Dictionary<T, int> Id = new();
    public int Size(T n) => Comps[Id[n]].Count;
}

// Tarjan SCC; node + neighbour order preserved → deterministic component ids.
internal static class Scc
{
    public static Scc<T> Of<T>(IList<T> nodes, Dictionary<T, List<T>> adj) where T : notnull
    {
        var scc = new Scc<T>();
        int idx = 0;
        var stack = new List<T>();
        var onStack = new HashSet<T>();
        var index = new Dictionary<T, int>();
        var low = new Dictionary<T, int>();
        var cmp = EqualityComparer<T>.Default;

        void Strong(T v)
        {
            index[v] = idx; low[v] = idx; idx++;
            stack.Add(v); onStack.Add(v);
            if (adj.TryGetValue(v, out var ns))
            {
                foreach (var w in ns)
                {
                    if (!index.ContainsKey(w)) { Strong(w); low[v] = Math.Min(low[v], low[w]); }
                    else if (onStack.Contains(w)) low[v] = Math.Min(low[v], index[w]);
                }
            }
            if (low[v] == index[v])
            {
                var comp = new List<T>();
                T w;
                do
                {
                    w = stack[^1]; stack.RemoveAt(stack.Count - 1);
                    onStack.Remove(w); comp.Add(w);
                } while (!cmp.Equals(w, v));
                int ci = scc.Comps.Count;
                scc.Comps.Add(comp);
                foreach (var n in comp) scc.Id[n] = ci;
            }
        }

        foreach (var n in nodes) if (!index.ContainsKey(n)) Strong(n);
        return scc;
    }
}
