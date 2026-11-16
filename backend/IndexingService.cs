using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace ParallelSearch.Server;

internal sealed class IndexingService
{
    internal sealed record DocLocation(short FileIndex, long ByteOffset, int Length);
    internal sealed record IndexResult(int DocumentsIndexed, long TimeMs);

    private readonly string _datasetPath;
    private readonly object _buildGate = new();
    private volatile InvertedIndex _index = new();
    private volatile ConcurrentDictionary<string, string> _docTitles = new(StringComparer.Ordinal);
    private volatile ConcurrentDictionary<string, DocLocation> _docLocations = new(StringComparer.Ordinal);
    private volatile IReadOnlyList<string> _datasetFiles = Array.Empty<string>();
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
            _index = new InvertedIndex();
            _docTitles = new ConcurrentDictionary<string, string>(StringComparer.Ordinal);
            _docLocations = new ConcurrentDictionary<string, DocLocation>(StringComparer.Ordinal);
            _datasetFiles = Array.Empty<string>();
            Volatile.Write(ref _documentsIndexed, 0);
            Interlocked.Exchange(ref _lastBuildTimeMs, 0);
            Volatile.Write(ref _lastThreadsUsed, 0);
            GC.Collect();

            var newIndex = new InvertedIndex();
            var newTitles = new ConcurrentDictionary<string, string>(StringComparer.Ordinal);
            var newLocations = new ConcurrentDictionary<string, DocLocation>(StringComparer.Ordinal);
            var files = ListDatasetFiles();
            var fileIndexes = new Dictionary<string, short>(StringComparer.Ordinal);
            for (var i = 0; i < files.Count; i++)
            {
                fileIndexes[files[i]] = unchecked((short)i);
            }

            var indexedCounter = new int[1];
            var chunks = SplitIntoChunks(files, threadCount);
            var pool = new ThreadPool(threadCount);
            var stopwatch = Stopwatch.StartNew();

            try
            {
                foreach (var chunk in chunks)
                {
                    pool.Submit(() => IndexChunk(
                        chunk, fileIndexes, newIndex, newTitles, newLocations, indexedCounter));
                }

                pool.AwaitCompletion();
            }
            finally
            {
                pool.Shutdown();
            }

            stopwatch.Stop();
            _index = newIndex;
            _docTitles = newTitles;
            _docLocations = newLocations;
            _datasetFiles = files;
            Volatile.Write(ref _documentsIndexed, indexedCounter[0]);
            Interlocked.Exchange(ref _lastBuildTimeMs, stopwatch.ElapsedMilliseconds);
            Volatile.Write(ref _lastThreadsUsed, threadCount);

            return new IndexResult(indexedCounter[0], stopwatch.ElapsedMilliseconds);
        }
    }

    public InvertedIndex GetIndex() => _index;

    public string GetTitle(string docId) => _docTitles.GetValueOrDefault(docId, string.Empty);

    public string? GetRawDocumentJson(string docId)
    {
        var locations = _docLocations;
        var files = _datasetFiles;
        if (!locations.TryGetValue(docId, out var location) ||
            location.FileIndex < 0 ||
            location.FileIndex >= files.Count)
        {
            return null;
        }

        try
        {
            using var stream = new FileStream(files[location.FileIndex], FileMode.Open, FileAccess.Read, FileShare.Read);
            stream.Seek(location.ByteOffset, SeekOrigin.Begin);
            var bytes = new byte[location.Length];
            var totalRead = 0;
            while (totalRead < bytes.Length)
            {
                var count = stream.Read(bytes, totalRead, bytes.Length - totalRead);
                if (count == 0)
                {
                    break;
                }

                totalRead += count;
            }

            return Encoding.UTF8.GetString(bytes, 0, totalRead).Trim();
        }
        catch (IOException exception)
        {
            Console.Error.WriteLine($"Failed to read raw document {docId}: {exception.Message}");
            return null;
        }
        catch (UnauthorizedAccessException exception)
        {
            Console.Error.WriteLine($"Failed to read raw document {docId}: {exception.Message}");
            return null;
        }
    }

    private List<string> ListDatasetFiles()
    {
        try
        {
            return Directory.GetFiles(_datasetPath).ToList();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new InvalidOperationException($"Failed to read dataset directory: {_datasetPath}", exception);
        }
    }

    private static List<List<string>> SplitIntoChunks(IReadOnlyList<string> files, int chunkCount)
    {
        var chunks = new List<List<string>>();
        if (files.Count == 0 || chunkCount <= 0)
        {
            return chunks;
        }

        var baseSize = files.Count / chunkCount;
        var remainder = files.Count % chunkCount;
        var startIndex = 0;
        for (var i = 0; i < chunkCount; i++)
        {
            var currentSize = baseSize + (i < remainder ? 1 : 0);
            if (currentSize > 0)
            {
                chunks.Add(files.Skip(startIndex).Take(currentSize).ToList());
                startIndex += currentSize;
            }
        }

        return chunks;
    }

    private static void IndexChunk(
        IReadOnlyList<string> chunk,
        IReadOnlyDictionary<string, short> fileIndexes,
        InvertedIndex targetIndex,
        ConcurrentDictionary<string, string> targetTitles,
        ConcurrentDictionary<string, DocLocation> targetLocations,
        int[] indexedCounter)
    {
        foreach (var file in chunk)
        {
            var fileIndex = fileIndexes.GetValueOrDefault(file);
            try
            {
                using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
                var buffer = new byte[64 * 1024];
                var lineBuffer = new byte[8192];
                var lineLength = 0;
                long currentPosition = 0;
                long lineStartOffset = 0;

                void ProcessLine()
                {
                    var textLength = lineLength;
                    if (textLength > 0 && lineBuffer[textLength - 1] == '\r')
                    {
                        textLength--;
                    }

                    if (textLength > 0)
                    {
                        var line = Encoding.UTF8.GetString(lineBuffer, 0, textLength);
                        if (!string.IsNullOrWhiteSpace(line))
                        {
                            try
                            {
                                var product = JsonSerializer.Deserialize<ProductDocument>(line);
                                if (product is not null)
                                {
                                    var docId = product.ParentAsin;
                                    var text = BuildIndexableText(product);
                                    if (docId is not null && !string.IsNullOrWhiteSpace(text))
                                    {
                                        targetIndex.AddDocument(docId, text);
                                        if (product.Title is not null)
                                        {
                                            targetTitles[docId] = product.Title;
                                        }

                                        var documentLength = checked((int)(currentPosition - lineStartOffset));
                                        targetLocations[docId] = new DocLocation(fileIndex, lineStartOffset, documentLength);
                                        Interlocked.Increment(ref indexedCounter[0]);
                                    }
                                }
                            }
                            catch (JsonException exception)
                            {
                                Console.Error.WriteLine($"Failed to parse line in {file}: {exception.Message}");
                            }
                        }
                    }

                    lineLength = 0;
                    lineStartOffset = currentPosition;
                }

                int bytesRead;
                while ((bytesRead = stream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    for (var i = 0; i < bytesRead; i++)
                    {
                        var value = buffer[i];
                        currentPosition++;
                        if (value == (byte)'\n')
                        {
                            ProcessLine();
                        }
                        else
                        {
                            if (lineLength == lineBuffer.Length)
                            {
                                Array.Resize(ref lineBuffer, lineBuffer.Length * 2);
                            }

                            lineBuffer[lineLength++] = value;
                        }
                    }
                }
            }
            catch (IOException exception)
            {
                Console.Error.WriteLine($"Failed to read file: {file} — {exception.Message}");
            }
            catch (UnauthorizedAccessException exception)
            {
                Console.Error.WriteLine($"Failed to read file: {file} — {exception.Message}");
            }
        }
    }

    private static string BuildIndexableText(ProductDocument product)
    {
        var builder = new StringBuilder();
        if (product.Title is not null)
        {
            builder.Append(product.Title).Append(' ');
        }

        if (product.Features is not null)
        {
            foreach (var feature in product.Features)
            {
                builder.Append(feature).Append(' ');
            }
        }

        if (product.Description is not null)
        {
            foreach (var description in product.Description)
            {
                builder.Append(description).Append(' ');
            }
        }

        if (product.Store is not null)
        {
            builder.Append(product.Store);
        }

        return builder.ToString();
    }
}
