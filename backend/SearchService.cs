namespace ParallelSearch.Server;

internal sealed class SearchService
{
    private readonly IndexingService _indexingService;

    public SearchService(IndexingService indexingService)
    {
        _indexingService = indexingService;
    }

    public IReadOnlyList<SearchResult> KeywordSearch(string query, int? top, out long elapsedMs)
    {
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        var index = _indexingService.GetIndex();
        
        var terms = query.Split(new[] { ' ', ',', '.', '!', '?' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(t => t.ToLowerInvariant())
            .Where(t => t.Length > 1)
            .Distinct()
            .ToList();

        if (terms.Count == 0)
        {
            elapsedMs = 0;
            return Array.Empty<SearchResult>();
        }

        var scores = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var term in terms)
        {
            var postings = index.GetPostings(term);
            if (postings is null) continue;

            foreach (var posting in postings)
            {
                scores[posting.DocId] = scores.TryGetValue(posting.DocId, out var score) 
                    ? score + posting.Frequency 
                    : posting.Frequency;
            }
        }

        var limit = top ?? 5;
        var results = scores
            .OrderByDescending(pair => pair.Value)
            .Take(limit)
            .Select(pair => new SearchResult(
                pair.Key, 
                pair.Value, 
                _indexingService.GetTitle(pair.Key)))
            .ToList();

        stopwatch.Stop();
        elapsedMs = stopwatch.ElapsedMilliseconds;
        return results;
    }

    public IReadOnlyList<SearchResult> LoadRawDocuments(IReadOnlyList<SearchResult> results)
    {
        var enhanced = new List<SearchResult>(results.Count);
        foreach (var r in results)
        {
            var rawJson = _indexingService.GetRawDocumentJson(r.DocId);
            System.Text.Json.JsonElement? rawElement = null;
            if (rawJson is not null)
            {
                try { rawElement = System.Text.Json.JsonDocument.Parse(rawJson).RootElement; } catch { }
            }
            enhanced.Add(new SearchResult(r.DocId, r.Score, r.Snippet, rawElement));
        }
        return enhanced;
    }
}