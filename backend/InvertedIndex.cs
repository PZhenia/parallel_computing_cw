namespace ParallelSearch.Server;

internal sealed class InvertedIndex
{
    public sealed record Posting(string DocId, int Frequency);

    private readonly CustomHashMap<ConcurrentPostingList> _index = new();

    public void AddDocument(string docId, string text)
    {
        var words = text.Split(new[] { ' ', ',', '.', '!', '?' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (var word in words)
        {
            var term = word.ToLowerInvariant();
            var postings = _index.GetOrCreate(term, () => new ConcurrentPostingList());
            postings.Add(new Posting(docId, 1));
        }
    }
}