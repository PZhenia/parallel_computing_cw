using System.Net.WebSockets;
using System.Text.Json;

namespace ParallelSearch.Server;

internal sealed class WebSocketSearchHandler(OllamaClient ollama, SearchService search)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true
    };

    public async Task HandleAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        while (socket.State == WebSocketState.Open)
        {
            var message = await ReceiveTextMessageAsync(socket, context.RequestAborted);
            if (message is null)
            {
                break;
            }

            var incoming = JsonSerializer.Deserialize<IncomingQuery>(message, JsonOptions);
            if (incoming is null || string.IsNullOrWhiteSpace(incoming.Query))
            {
                await SendJsonAsync(socket, new ErrorMessage("error", "Query must not be empty"), context.RequestAborted);
                continue;
            }

            var query = incoming.Query;
            var expandedTerms = await ollama.ExpandQueryAsync(query);
            await SendJsonAsync(
                socket,
                new StageMessage("query_expansion", new QueryExpansionData(query, expandedTerms)),
                context.RequestAborted);
            if (expandedTerms.Count > 0)
            {
                query += " " + string.Join(' ', expandedTerms);
            }

            var results = search.KeywordSearch(query, incoming.Top, out var elapsedMs);
            var responseResults = search.LoadRawDocuments(results);
            await SendJsonAsync(
                socket,
                new StageMessage("keyword_search", new KeywordSearchData(responseResults, elapsedMs)),
                context.RequestAborted);
            await SendJsonAsync(socket, new DoneMessage("done"), context.RequestAborted);
        }
    }

    private static async Task<string?> ReceiveTextMessageAsync(WebSocket socket, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        while (true)
        {
            var received = await socket.ReceiveAsync(new ArraySegment<byte>(chunk), cancellationToken);
            if (received.MessageType == WebSocketMessageType.Close)
            {
                if (socket.State == WebSocketState.CloseReceived)
                {
                    await socket.CloseOutputAsync(
                        received.CloseStatus ?? WebSocketCloseStatus.NormalClosure,
                        received.CloseStatusDescription,
                        cancellationToken);
                }

                return null;
            }

            if (received.MessageType != WebSocketMessageType.Text)
            {
                throw new InvalidOperationException("Only text WebSocket messages are supported.");
            }

            if (buffer.Length + received.Count > 1024 * 1024)
            {
                throw new InvalidOperationException("WebSocket message exceeds the 1 MiB limit.");
            }

            buffer.Write(chunk, 0, received.Count);
            if (received.EndOfMessage)
            {
                return System.Text.Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
            }
        }
    }

    private static Task SendJsonAsync(WebSocket socket, object message, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message, JsonOptions);
        return socket.SendAsync(new ArraySegment<byte>(payload), WebSocketMessageType.Text, true, cancellationToken);
    }

    private sealed record IncomingQuery(string? Query, int? Top);
    private sealed record StageMessage(string Stage, object Data);
    private sealed record QueryExpansionData(string Original, IReadOnlyList<string> ExpandedTerms);
    private sealed record KeywordSearchData(IReadOnlyList<SearchResult> Results, long TimeMs);
    private sealed record DoneMessage(string Stage);
    private sealed record ErrorMessage(string Stage, string Message);
}
