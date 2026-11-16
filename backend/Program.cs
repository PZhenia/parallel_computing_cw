using System.Text.Json;
using ParallelSearch.Server;

var builder = WebApplication.CreateBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;
    options.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.SnakeCaseLower;
    options.SerializerOptions.PropertyNameCaseInsensitive = true;
});
builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
    policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));
builder.Services.AddHttpClient("ollama", client => client.Timeout = TimeSpan.FromMinutes(5));
builder.Services.AddSingleton<OllamaClient>();
builder.Services.AddSingleton<IndexingService>();
builder.Services.AddSingleton<SearchService>();
builder.Services.AddSingleton<WebSocketSearchHandler>();

var app = builder.Build();
app.UseCors();
app.UseWebSockets();

app.MapGet("/api/health", async (OllamaClient ollama, CancellationToken cancellationToken) =>
    Results.Ok(new HealthResponse("ok", await ollama.IsAvailableAsync(cancellationToken))));

app.MapGet("/api/stats", (IndexingService index) => Results.Ok(new StatsResponse(
    index.DocumentsIndexed,
    index.LastBuildTimeMs,
    index.LastThreadsUsed)));

app.MapPost("/api/index", (IndexRequest? request, IndexingService index) =>
{
    var threads = request?.Threads is > 0
        ? request.Threads.Value
        : Environment.ProcessorCount;
    var result = index.BuildIndex(threads);
    return Results.Ok(new IndexResponse("ok", result.DocumentsIndexed, result.TimeMs));
});

app.MapPost("/api/search", async (SearchRequest request, SearchService search, OllamaClient ollama) =>
{
    if (string.IsNullOrWhiteSpace(request.Query))
    {
        return Results.Ok(new SearchResponse([], 0));
    }

    var synonyms = await ollama.ExpandQueryAsync(request.Query);
    var queryToSearch = request.Query;
    if (synonyms.Count > 0)
    {
        queryToSearch += " " + string.Join(' ', synonyms);
    }

    var results = search.KeywordSearch(queryToSearch, request.Top, out var elapsedMs);
    var responseResults = search.LoadRawDocuments(results);
    return Results.Ok(new SearchResponse(responseResults, elapsedMs, synonyms));
});

app.Map("/ws/search", (HttpContext context, WebSocketSearchHandler handler) => handler.HandleAsync(context));

app.Run();

internal sealed record HealthResponse(string Status, bool Ollama);
internal sealed record IndexRequest(int? Threads);
internal sealed record IndexResponse(string Status, int DocumentsIndexed, long TimeMs);
internal sealed record StatsResponse(int Documents, long IndexBuildTimeMs, int ThreadsUsed);
internal sealed record SearchRequest(string? Query, int? Top);

internal sealed record SearchResponse(
    IReadOnlyList<SearchResult> Results,
    long TimeMs,
    [property: System.Text.Json.Serialization.JsonIgnore(
        Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    IReadOnlyList<string>? Synonyms = null);

internal sealed record SearchResult(
    string DocId,
    double Score,
    string Snippet,
    [property: System.Text.Json.Serialization.JsonIgnore(
        Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    JsonElement? Raw = null);
