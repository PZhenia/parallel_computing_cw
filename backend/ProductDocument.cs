using System.Text.Json.Serialization;

namespace ParallelSearch.Server;

internal sealed record ProductDocument(
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("parent_asin")] string? ParentAsin);