using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;

namespace ParallelSearch.Server;

internal sealed class IndexingService
{
    internal sealed record IndexResult(int DocumentsIndexed, long TimeMs);

    private readonly string _datasetPath;
    private readonly object _buildGate = new();
    private volatile InvertedIndex _index = new();
    private int _documentsIndexed;
    private long _lastBuildTimeMs;
    private int _lastThreadsUsed;

    public IndexingService(IConfiguration configuration)
    {
        _datasetPath = Environment.GetEnvironmentVariable("SEARCH_DATASET_PATH")
            ?? configuration["search.dataset.path"]
            ?? Path.Combine("data", "batched");
    }

    public int DocumentsIndexed => Volatile.Read(ref _documentsIndexed);
    public long LastBuildTimeMs => Interlocked.Read(ref _lastBuildTimeMs);
    public int LastThreadsUsed => Volatile.Read(ref _lastThreadsUsed);

    public IndexResult BuildIndex(int threadCount)
    {
        lock (_buildGate)
        {
            var newIndex = new InvertedIndex();
            var files = Directory.GetFiles(_datasetPath).ToList();
            var indexedCounter = new int[1];
            
            var pool = new ThreadPool(threadCount);
            var stopwatch = Stopwatch.StartNew();

            try
            {
                foreach (var file in files)
                {
                    pool.Submit(() => IndexFile(file, newIndex, indexedCounter));
                }
                pool.AwaitCompletion();
            }
            finally
            {
                pool.Shutdown();
            }

            stopwatch.Stop();
            _index = newIndex;
            Volatile.Write(ref _documentsIndexed, indexedCounter[0]);
            Interlocked.Exchange(ref _lastBuildTimeMs, stopwatch.ElapsedMilliseconds);
            Volatile.Write(ref _lastThreadsUsed, threadCount);

            return new IndexResult(indexedCounter[0], stopwatch.ElapsedMilliseconds);
        }
    }

    public InvertedIndex GetIndex() => _index;

    private static void IndexFile(string file, InvertedIndex targetIndex, int[] indexedCounter)
    {
        foreach (var line in File.ReadLines(file))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                var product = JsonSerializer.Deserialize<ProductDocument>(line);
                if (product?.ParentAsin is not null && product.Title is not null)
                {
                    targetIndex.AddDocument(product.ParentAsin, product.Title);
                    Interlocked.Increment(ref indexedCounter[0]);
                }
            }
            catch (JsonException) { }
        }
    }
}