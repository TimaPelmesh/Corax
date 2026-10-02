using System.IO;
using System.Text;
using System.Text.Json;

namespace Corax.Client;

public sealed class ClientSettings
{
    public string ServerUrl { get; set; } = "";
    public string HandlerSecret { get; set; } = "";
    public bool Dark { get; set; } = true;
    public bool Autostart { get; set; } = true;

    static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };

    public static string LocalPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CORAX", "Client", "client.json");

    public static ClientSettings Load()
    {
        var settings = new ClientSettings();
        ApplyJson(settings, ReadStampedSlot());
        ApplyJson(settings, ReadFile(Path.Combine(AppContext.BaseDirectory, "client.json")));
        ApplyJson(settings, ReadFile(LocalPath));
        return settings;
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(LocalPath)!);
        File.WriteAllText(LocalPath, JsonSerializer.Serialize(this, JsonOpts));
    }

    static void ApplyJson(ClientSettings settings, string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.TryGetProperty("server_url", out var snake) || root.TryGetProperty("serverUrl", out snake))
            {
                var url = snake.GetString()?.Trim() ?? "";
                settings.ServerUrl = url.TrimEnd('/');
            }
            if (root.TryGetProperty("handler_secret", out var secret) || root.TryGetProperty("handlerSecret", out secret))
                settings.HandlerSecret = secret.GetString() ?? "";
            if (root.TryGetProperty("dark", out var dark) && (dark.ValueKind == JsonValueKind.True || dark.ValueKind == JsonValueKind.False))
                settings.Dark = dark.GetBoolean();
            if (root.TryGetProperty("autostart", out var auto) && (auto.ValueKind == JsonValueKind.True || auto.ValueKind == JsonValueKind.False))
                settings.Autostart = auto.GetBoolean();
        }
        catch (JsonException)
        {
            /* ignore a broken local file */
        }
    }

    static string? ReadFile(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    static string? ReadStampedSlot()
    {
        var paths = new[]
        {
            Environment.ProcessPath,
            Path.Combine(AppContext.BaseDirectory, "Corax.dll"),
            Path.Combine(AppContext.BaseDirectory, "Corax.exe"),
        };
        string? best = null;
        var bestLen = -1;
        foreach (var path in paths)
        {
            var json = ExtractSlot(path);
            if (json != null && json.Length > bestLen)
            {
                best = json;
                bestLen = json.Length;
            }
        }
        // Touch the literal so the compiler keeps the UTF-16 slot in the binary.
        _ = ConfigSlot.Slot.Length;
        return best;
    }

    static string? ExtractSlot(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(path);
        }
        catch (IOException)
        {
            return null;
        }
        var begin = Encoding.Unicode.GetBytes("<<<CORAX_CFG_BEGIN>>>");
        var end = Encoding.Unicode.GetBytes("<<<CORAX_CFG_END>>>");
        var start = 0;
        string? widest = null;
        while (start < bytes.Length)
        {
            var at = IndexOf(bytes, begin, start);
            if (at < 0) break;
            var stop = IndexOf(bytes, end, at + begin.Length);
            if (stop < 0) break;
            var payload = Encoding.Unicode.GetString(bytes, at + begin.Length, stop - (at + begin.Length));
            payload = payload.Trim('\0', ' ', '\r', '\n');
            if (payload.StartsWith('{') && (widest == null || payload.Length > widest.Length))
                widest = payload;
            start = at + 2;
        }
        return widest;
    }

    static int IndexOf(byte[] hay, byte[] needle, int start)
    {
        for (var i = Math.Max(0, start); i + needle.Length <= hay.Length; i++)
        {
            var ok = true;
            for (var j = 0; j < needle.Length; j++)
            {
                if (hay[i + j] != needle[j])
                {
                    ok = false;
                    break;
                }
            }
            if (ok) return i;
        }
        return -1;
    }
}
