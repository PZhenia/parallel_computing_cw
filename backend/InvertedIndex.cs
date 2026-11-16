using System.Text.RegularExpressions;

namespace ParallelSearch.Server;

internal sealed class InvertedIndex
{
    internal sealed record Posting(string DocId, int TermFrequency);

    private static readonly Regex WordSeparators = new(
        "[^A-Za-z0-9_]+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private readonly CustomHashMap<ConcurrentPostingList> _index = new();

    public void AddDocument(string docId, string content)
    {
        var termCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var word in WordSeparators.Split(content.ToLowerInvariant()))
        {
            if (word.Length > 0)
            {
                termCounts[word] = termCounts.GetValueOrDefault(word) + 1;
            }
        }

        foreach (var (term, frequency) in termCounts)
        {
            _index.GetOrCreate(term, static () => new ConcurrentPostingList())
                .Add(new Posting(docId, frequency));
        }
    }

    public IReadOnlyList<Posting> Lookup(string term)
    {
        var list = _index.Get(term.ToLowerInvariant());
        return list is null ? [] : list.ToList();
    }

    public int Size => _index.Size;
}
