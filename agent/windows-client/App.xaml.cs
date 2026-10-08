using System.IO;
using System.Windows;
using Media = System.Windows.Media;

namespace Corax.Client;

public partial class App : System.Windows.Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += (_, args) =>
        {
            WriteCrash(args.Exception);
            args.Handled = true;
            Shutdown(1);
        };
        base.OnStartup(e);
        try
        {
            Start(e);
        }
        catch (Exception ex)
        {
            WriteCrash(ex);
            Shutdown(1);
        }
    }

    void Start(StartupEventArgs e)
    {
        MachineInstall.EnsureRdpProtocol();
        if (MachineInstall.TryLaunchRdp(e.Args))
        {
            Shutdown();
            return;
        }
        var settings = ClientSettings.Load();
        ApplyTheme(settings.Dark);
        var forceApp = e.Args.Any(a => a.Equals("--app", StringComparison.OrdinalIgnoreCase));
        var forceSetup = e.Args.Any(a => a.Equals("--setup", StringComparison.OrdinalIgnoreCase));
        Window window = forceSetup || (!forceApp && !MachineInstall.IsInstalledCopy())
            ? new InstallWindow()
            : new ShellWindow();
        MainWindow = window;
        window.Show();
    }

    public static void WriteCrash(Exception ex)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CORAX", "Client");
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "crash.log"), ex.ToString());
        }
        catch (Exception)
        {
            /* last resort: the process is already failing */
        }
    }

    public static void ApplyTheme(bool dark)
    {
        if (Current == null) return;
        void Paint(string key, string hex)
        {
            var color = (Media.Color)Media.ColorConverter.ConvertFromString(hex);
            if (Current.Resources[key] is Media.SolidColorBrush brush && !brush.IsFrozen)
            {
                brush.Color = color;
                return;
            }
            Current.Resources[key] = new Media.SolidColorBrush(color);
        }

        if (dark)
        {
            Paint("Bg", "#202020");
            Paint("Pane", "#CC202020");
            Paint("Surface", "#E62C2C2C");
            Paint("SurfaceMuted", "#14FFFFFF");
            Paint("Fg", "#F3F3F3");
            Paint("Muted", "#C5C5C5");
            Paint("Border", "#15FFFFFF");
            Paint("Primary", "#60A5FA");
            Paint("PrimarySoft", "#332563EB");
            Paint("OnPrimary", "#0A0A0A");
            Paint("Danger", "#FECACA");
            Paint("DangerBg", "#3F1D1D");
            Paint("FgSubtle", "#9A9A9A");
            Paint("BorderStrong", "#28FFFFFF");
            Paint("PrimaryHover", "#93C5FD");
            Paint("InfoBg", "#332563EB");
            Paint("InfoFg", "#BFDBFE");
            Paint("CaptionHover", "#18FFFFFF");
            Paint("CaptionCloseBg", "#C42B1C");
        }
        else
        {
            Paint("Bg", "#F3F3F3");
            Paint("Pane", "#B3FFFFFF");
            Paint("Surface", "#E6FFFFFF");
            Paint("SurfaceMuted", "#0A000000");
            Paint("Fg", "#1A1A1A");
            Paint("Muted", "#5C5C5C");
            Paint("Border", "#0F000000");
            Paint("Primary", "#2563EB");
            Paint("PrimarySoft", "#EFF6FF");
            Paint("OnPrimary", "#FFFFFF");
            Paint("Danger", "#991B1B");
            Paint("DangerBg", "#FEF2F2");
            Paint("FgSubtle", "#6B6B6B");
            Paint("BorderStrong", "#1A000000");
            Paint("PrimaryHover", "#1D4ED8");
            Paint("InfoBg", "#EFF6FF");
            Paint("InfoFg", "#1E40AF");
            Paint("CaptionHover", "#0F000000");
            Paint("CaptionCloseBg", "#C42B1C");
        }

        WindowBackdrop.RefreshOpenWindows();
    }
}
