using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ParallelSearch.Server;

internal sealed class SearchService(IndexingService indexingService)
{
    private const int DefaultResults = 5;
    private const int MaximumResults = 100;
    private static readonly Regex WordSeparators = new(
        "[^A-Za-z0-9_]+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public IReadOnlyList<ScoredDocument> KeywordSearch(string query, int? requestedTop, out long elapsedMs)
    {
        var limit = requestedTop is null or <= 0
            ? DefaultResults
            : Math.Min(requestedTop.Value, MaximumResults);
        var stopwatch = Stopwatch.StartNew();
        var index = indexingService.GetIndex();
        var terms = WordSeparators.Split(query.ToLowerInvariant());
        var scores = new Dictionary<string, double>(StringComparer.Ordinal);

        foreach (var term in terms)
        {
            if (term.Length == 0)
            {
                continue;
            }

            foreach (var posting in index.Lookup(term))
            {
                scores[posting.DocId] = scores.GetValueOrDefault(posting.DocId) + posting.TermFrequency;
            }
        }

        var minimumHeap = new PriorityQueue<KeyValuePair<string, double>, double>();
        foreach (var entry in scores)
        {
            if (minimumHeap.Count < limit)
            {
                minimumHeap.Enqueue(entry, entry.Value);
            }
            else if (minimumHeap.TryPeek(out _, out var minimum) && entry.Value > minimum)
            {
                minimumHeap.Dequeue();
                minimumHeap.Enqueue(entry, entry.Value);
            }
        }

        var results = new List<ScoredDocument>(minimumHeap.Count);
        while (minimumHeap.TryDequeue(out var entry, out _))
        {
            results.Add(new ScoredDocument(
                entry.Key,
                entry.Value,
                indexingService.GetTitle(entry.Key)));
        }

        results.Reverse();
        stopwatch.Stop();
        elapsedMs = stopwatch.ElapsedMilliseconds;
        return results;
    }

    public IReadOnlyList<SearchResult> LoadRawDocuments(IReadOnlyList<ScoredDocument> documents)
    {
        var results = new List<SearchResult>(documents.Count);
        foreach (var document in documents)
        {
            JsonElement? raw = null;
            var rawJson = indexingService.GetRawDocumentJson(document.DocId);
            if (rawJson is not null)
            {
                try
                {
                    using var parsed = JsonDocument.Parse(rawJson);
                    raw = parsed.RootElement.Clone();
                }
                catch (JsonException exception)
                {
                    Console.Error.WriteLine($"Failed to parse raw document {document.DocId}: {exception.Message}");
                }
            }

            results.Add(new SearchResult(document.DocId, document.Score, document.Title, raw));
        }

        return results;
    }

    internal sealed record ScoredDocument(string DocId, double Score, string Title);
}
