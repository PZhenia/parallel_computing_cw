using System.Net.Http.Json;
using System.Text.RegularExpressions;
using System.Text.Json.Serialization;

namespace ParallelSearch.Server;

internal sealed class OllamaClient(IHttpClientFactory httpClientFactory, IConfiguration configuration)
{
    private static readonly Regex TermCleanup = new(
        "^[\\\"'\\-\\d.]+|[\\\"'.]+$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private readonly string _baseUrl =
        Environment.GetEnvironmentVariable("OLLAMA_BASE_URL")
        ?? configuration["ollama.base-url"]
        ?? "http://localhost:11434";
    private readonly string _model =
        Environment.GetEnvironmentVariable("OLLAMA_MODEL")
        ??
        configuration["ollama.model"]
        ?? "llama3.2:1b";

    public async Task<bool> IsAvailableAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(3));
            using var response = await httpClientFactory.CreateClient("ollama")
                .GetAsync($"{_baseUrl.TrimEnd('/')}/api/tags", timeout.Token);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }

    public async Task<List<string>> ExpandQueryAsync(string query)
    {
        var prompt = $$"""
                <|start_header_id|>system<|end_header_id|>
                You are a shopping search query expansion engine. For the given product query, provide 3 to 5 close product synonyms or alternative shopping terms for the exact same item.
                Output ONLY a single comma-separated list of terms. Do NOT include explanations, introductory words, or punctuation marks.<|eot_id|>
                <|start_header_id|>user<|end_header_id|>
                Product query: "{{query}}"<|eot_id|>
                <|start_header_id|>assistant<|end_header_id|>
                """;

        try
        {
            var client = httpClientFactory.CreateClient("ollama");
            using var response = await client.PostAsJsonAsync(
                $"{_baseUrl.TrimEnd('/')}/api/generate",
                new GenerateRequest(_model, prompt, false));
            response.EnsureSuccessStatusCode();
            var generated = await response.Content.ReadFromJsonAsync<GenerateResponse>();
            return generated?.Response is null ? [] : ParseTerms(generated.Response);
        }
        catch (HttpRequestException exception)
        {
            Console.Error.WriteLine($"Ollama query expansion failed: {exception.Message}");
            return [];
        }
        catch (OperationCanceledException exception)
        {
            Console.Error.WriteLine($"Ollama query expansion failed: {exception.Message}");
            return [];
        }
        catch (System.Text.Json.JsonException exception)
        {
            Console.Error.WriteLine($"Ollama query expansion failed: {exception.Message}");
            return [];
        }
    }

    private static List<string> ParseTerms(string rawResponse)
    {
        var text = rawResponse.Replace('\n', ',');
        var colonIndex = text.IndexOf(':');
        var commaIndex = text.IndexOf(',');
        if (colonIndex != -1 && (commaIndex == -1 || colonIndex < commaIndex))
        {
            text = text[(colonIndex + 1)..];
        }

        var parts = text.Contains(',') ? text.Split(',') : Regex.Split(text, "\\s+");
        var terms = new List<string>();
        foreach (var part in parts)
        {
            var cleaned = TermCleanup.Replace(part.Trim().ToLowerInvariant(), string.Empty).Trim();
            if (cleaned.Length > 0 &&
                cleaned.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length <= 4 &&
                !terms.Contains(cleaned, StringComparer.Ordinal))
            {
                terms.Add(cleaned);
            }
        }

        return terms;
    }

    private sealed record GenerateRequest(
        [property: JsonPropertyName("model")] string Model,
        [property: JsonPropertyName("prompt")] string Prompt,
        [property: JsonPropertyName("stream")] bool Stream);

    private sealed record GenerateResponse(
        [property: JsonPropertyName("response")] string? Response);
}
