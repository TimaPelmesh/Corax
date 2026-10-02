using System.Diagnostics;
using System.IO;
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
