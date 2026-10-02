using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace Corax.Client;

public sealed class TicketItem
{
    public int Id { get; init; }
    public string Number { get; init; } = "";
    public string Title { get; init; } = "";
    public string Status { get; init; } = "";
    public string StatusLabel { get; init; } = "";
    public string When { get; init; } = "";
}

public sealed class DirectoryPerson
{
    public string Name { get; init; } = "";
    public string Username { get; init; } = "";
    public string Phone { get; init; } = "";
    public string Email { get; init; } = "";
    public string Initials { get; init; } = "";
    public string Line { get; init; } = "";
}

public sealed class DeskContext
{
    public string Hostname { get; init; } = "";
    public string? Location { get; init; }
    public string? Requester { get; init; }
}

public sealed class CoraxApi : IDisposable
{
    readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(20) };
    readonly ClientSettings _settings;

    public CoraxApi(ClientSettings settings) => _settings = settings;

    public async Task<DeskContext> ContextAsync(CancellationToken cancel = default)
    {
        using var doc = await GetAsync("ticket-handler/public/context", cancel);
        var root = doc.RootElement;
        return new DeskContext
        {
            Hostname = Text(root, "hostname"),
            Location = EmptyToNull(Text(root, "location")),
            Requester = EmptyToNull(Text(root, "requester_hint")),
        };
    }

    public async Task<IReadOnlyList<TicketItem>> TicketsAsync(CancellationToken cancel = default)
    {
        using var doc = await GetAsync("ticket-handler/public/tickets", cancel);
        if (!doc.RootElement.TryGetProperty("items", out var items)) return Array.Empty<TicketItem>();
        var list = new List<TicketItem>();
        foreach (var row in items.EnumerateArray())
        {
            var status = Text(row, "status");
            var opened = Text(row, "opened_at");
            list.Add(new TicketItem
            {
                Id = row.TryGetProperty("id", out var id) && id.TryGetInt32(out var n) ? n : 0,
                Number = row.TryGetProperty("ticket_no", out var no) && no.ValueKind == JsonValueKind.Number
                    ? "№" + no.GetInt32()
                    : "",
                Title = Text(row, "title"),
                Status = status,
                StatusLabel = StatusLabel(status),
                When = FormatWhen(opened),
            });
        }
        return list;
    }

    public async Task<IReadOnlyList<DirectoryPerson>> DirectoryAsync(CancellationToken cancel = default)
    {
        using var doc = await GetAsync("ticket-handler/public/directory", cancel);
        if (!doc.RootElement.TryGetProperty("items", out var items)) return Array.Empty<DirectoryPerson>();
        var list = new List<DirectoryPerson>();
        foreach (var row in items.EnumerateArray())
        {
            var name = Text(row, "full_name");
            var username = Text(row, "username");
            var phone = Text(row, "phone");
            var email = Text(row, "email");
            var shown = string.IsNullOrWhiteSpace(name) ? username : name;
            var bits = new[] { username, phone, email }.Where(s => !string.IsNullOrWhiteSpace(s));
            list.Add(new DirectoryPerson
            {
                Name = shown,
                Username = username,
                Phone = phone,
                Email = email,
                Initials = Initials(shown),
                Line = string.Join("  ·  ", bits),
            });
        }
        return list;
    }

    public async Task<string> CreateTicketAsync(string title, string description, CancellationToken cancel = default)
    {
        var server = Server();
        var hostname = Environment.MachineName;
        var payload = JsonSerializer.Serialize(new
        {
            hostname,
            title,
            description,
            secret = string.IsNullOrWhiteSpace(_settings.HandlerSecret) ? null : _settings.HandlerSecret,
        });
        using var response = await _http.PostAsync(
            $"{server}/api/v1/ticket-handler/intake",
            new StringContent(payload, Encoding.UTF8, "application/json"),
            cancel);
        var body = await response.Content.ReadAsStringAsync(cancel);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(Detail(body) ?? $"Сервер ответил {(int)response.StatusCode}");
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.False)
            throw new InvalidOperationException(Text(root, "error_detail") is { Length: > 0 } err ? err : "Заявку не приняли");
        var number = root.TryGetProperty("ticket_no", out var no) && no.ValueKind == JsonValueKind.Number
            ? no.GetInt32().ToString()
            : "";
        return number.Length > 0 ? "Заявка №" + number + " создана" : "Заявка создана";
    }

    public void Dispose() => _http.Dispose();

    async Task<JsonDocument> GetAsync(string path, CancellationToken cancel)
    {
        var server = Server();
        var query = "hostname=" + Uri.EscapeDataString(Environment.MachineName);
        if (!string.IsNullOrWhiteSpace(_settings.HandlerSecret))
            query += "&secret=" + Uri.EscapeDataString(_settings.HandlerSecret);
        using var response = await _http.GetAsync($"{server}/api/v1/{path}?{query}", cancel);
        var body = await response.Content.ReadAsStringAsync(cancel);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(Detail(body) ?? $"Сервер ответил {(int)response.StatusCode}");
        return JsonDocument.Parse(body);
    }

    string Server()
    {
        var server = _settings.ServerUrl.Trim().TrimEnd('/');
        if (server.Length == 0)
            throw new InvalidOperationException("Укажите адрес панели в настройках");
        return server;
    }

    static string Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    static string? EmptyToNull(string value) => string.IsNullOrWhiteSpace(value) ? null : value;

    static string? Detail(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("detail", out var detail) && detail.ValueKind == JsonValueKind.String)
                return detail.GetString();
        }
        catch (JsonException)
        {
            return null;
        }
        return null;
    }

    static string StatusLabel(string status) => status switch
    {
        "open" => "Открыта",
        "in_progress" => "В работе",
        "done" => "Закрыта",
        "cancelled" => "Отменена",
        _ => status,
    };

    static string FormatWhen(string iso)
    {
        if (!DateTimeOffset.TryParse(iso, out var when)) return "";
        return when.ToLocalTime().ToString("d MMM, HH:mm");
    }

    static string Initials(string name)
    {
        var parts = name.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return "•";
        if (parts.Length == 1) return parts[0][..Math.Min(2, parts[0].Length)].ToUpperInvariant();
        return string.Concat(parts[0][0], parts[1][0]).ToUpperInvariant();
    }
}
