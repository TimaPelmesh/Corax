using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Corax.Client;

public static class MachineInstall
{
    public static string InstallDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CORAX", "Client");

    public static string InstallExe => Path.Combine(InstallDir, "Corax.exe");

    public static bool IsInstalledCopy()
    {
        var current = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(current)) return false;
        return string.Equals(Path.GetFullPath(current), Path.GetFullPath(InstallExe), StringComparison.OrdinalIgnoreCase);
    }

    public static void Install(bool autostart)
    {
        var source = Environment.ProcessPath ?? throw new InvalidOperationException("Не найден файл программы");
        Directory.CreateDirectory(InstallDir);
        var dest = InstallExe;
        if (!string.Equals(Path.GetFullPath(source), Path.GetFullPath(dest), StringComparison.OrdinalIgnoreCase))
            File.Copy(source, dest, overwrite: true);
        CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Corax.lnk"), dest);
        var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs");
        Directory.CreateDirectory(startMenu);
        CreateShortcut(Path.Combine(startMenu, "Corax.lnk"), dest);
        SetAutostart(autostart, dest);
        EnsureRdpProtocol(dest);
    }

    const string OpenRdpVbs = """
        Option Explicit
        Dim spec, host, sh, i, ch, decoded, ok
        If WScript.Arguments.Count < 1 Then WScript.Quit 1
        spec = Trim(WScript.Arguments(0))
        If Len(spec) >= 2 Then
          If Left(spec, 1) = Chr(34) And Right(spec, 1) = Chr(34) Then spec = Mid(spec, 2, Len(spec) - 2)
        End If
        If LCase(Left(spec, 10)) = "corax-rdp:" Then spec = Mid(spec, 11)
        Do While Left(spec, 1) = "/"
          spec = Mid(spec, 2)
        Loop
        If Right(spec, 1) = "/" Then spec = Left(spec, Len(spec) - 1)

        decoded = ""
        i = 1
        Do While i <= Len(spec)
          ch = Mid(spec, i, 1)
          If ch = "%" And i + 2 <= Len(spec) Then
            On Error Resume Next
            decoded = decoded & Chr(CLng("&H" & Mid(spec, i + 1, 2)))
            If Err.Number <> 0 Then
              Err.Clear
              decoded = decoded & ch
              i = i + 1
            Else
              i = i + 3
            End If
            On Error GoTo 0
          Else
            decoded = decoded & ch
            i = i + 1
          End If
        Loop

        host = Trim(decoded)
        If host = "" Or Len(host) > 255 Then WScript.Quit 1
        If InStr(host, "..") > 0 Then WScript.Quit 1
        ok = True
        For i = 1 To Len(host)
          ch = Mid(host, i, 1)
          If InStr("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-", ch) = 0 Then ok = False
        Next
        If Not ok Then WScript.Quit 1
        ch = Left(host, 1)
        If InStr("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", ch) = 0 Then WScript.Quit 1
        ch = Right(host, 1)
        If InStr("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", ch) = 0 Then WScript.Quit 1

        Set sh = CreateObject("WScript.Shell")
        sh.Run "mstsc.exe /v:" & host, 1, False
        """;

    public static void EnsureRdpProtocol(string? exe = null)
    {
        _ = exe;
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CORAX");
        Directory.CreateDirectory(dir);
        var helper = Path.Combine(dir, "open-rdp.vbs");
        File.WriteAllText(helper, OpenRdpVbs, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\corax-rdp");
        key?.SetValue("", "URL:CORAX Remote Desktop");
        key?.SetValue("URL Protocol", "");
        using var cmd = Registry.CurrentUser.CreateSubKey(@"Software\Classes\corax-rdp\shell\open\command");
        cmd?.SetValue("", $"wscript.exe //B //Nologo \"{helper}\" \"%1\"");
    }

    public static bool TryLaunchRdp(string[] args)
    {
        string? spec = null;
        for (var i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (a.Equals("--rdp", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                spec = args[++i];
                break;
            }
            if (a.StartsWith("corax-rdp:", StringComparison.OrdinalIgnoreCase))
            {
                spec = a;
                break;
            }
        }
        if (spec == null) return false;
        var host = RdpHostFromSpec(spec);
        if (host == null) return true;
        Process.Start(new ProcessStartInfo("mstsc.exe", "/v:" + host) { UseShellExecute = true });
        return true;
    }

    static string? RdpHostFromSpec(string spec)
    {
        var value = spec.Trim().Trim('"');
        const string prefix = "corax-rdp:";
        if (value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            value = Uri.UnescapeDataString(value[prefix.Length..]);
        value = value.Trim().Trim('/');
        if (string.IsNullOrWhiteSpace(value) || value.Length > 255) return null;
        if (value.Contains("..", StringComparison.Ordinal) || Regex.IsMatch(value, @"[\s\\/""'`;|$&<>]"))
            return null;
        if (Regex.IsMatch(value, @"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$"))
        {
            var parts = value.Split('.').Select(int.Parse).ToArray();
            if (parts[0] is <= 0 or 127 or >= 224) return null;
            if (parts.Any(n => n is < 0 or > 255)) return null;
            return string.Join('.', parts);
        }
        return Regex.IsMatch(value, @"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$") ? value : null;
    }

    public static void SetAutostart(bool enabled, string? exe = null)
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true)
            ?? throw new InvalidOperationException("Не удалось открыть автозагрузку");
        if (!enabled)
        {
            key.DeleteValue("Corax", throwOnMissingValue: false);
            return;
        }
        var target = exe ?? InstallExe;
        key.SetValue("Corax", $"\"{target}\" --app");
    }

    public static void LaunchInstalled()
    {
        Process.Start(new ProcessStartInfo(InstallExe, "--app") { UseShellExecute = true });
    }

    public static string? FindInventoryAgent()
    {
        var roots = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "CORAX", "Agent", "CORAX-Agent.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CORAX", "Agent", "CORAX-Agent.exe"),
        };
        return roots.FirstOrDefault(File.Exists);
    }

    static void CreateShortcut(string linkPath, string target)
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) return;
        dynamic shell = Activator.CreateInstance(shellType)!;
        dynamic shortcut = shell.CreateShortcut(linkPath);
        shortcut.TargetPath = target;
        shortcut.Arguments = "--app";
        shortcut.WorkingDirectory = Path.GetDirectoryName(target);
        shortcut.Description = "Corax — заявки и справочник";
        shortcut.Save();
    }
}
