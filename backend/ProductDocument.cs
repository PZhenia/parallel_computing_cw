using System.Text.Json.Serialization;

namespace ParallelSearch.Server;

internal sealed record ProductDocument(
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("features")] List<string>? Features,
    [property: JsonPropertyName("description")] List<string>? Description,
    [property: JsonPropertyName("store")] string? Store,
    [property: JsonPropertyName("parent_asin")] string? ParentAsin);
