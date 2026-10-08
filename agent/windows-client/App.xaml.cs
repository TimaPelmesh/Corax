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
            Paint("Bg", "#070B12");
            Paint("Surface", "#0A0A0A");
            Paint("SurfaceMuted", "#141414");
            Paint("Fg", "#F4F4F5");
            Paint("Muted", "#A1A1AA");
            Paint("Border", "#1C1C1C");
            Paint("Primary", "#60A5FA");
            Paint("PrimarySoft", "#243044");
            Paint("OnPrimary", "#0A0A0A");
            Paint("Danger", "#FECACA");
            Paint("DangerBg", "#3F1D1D");
            Paint("GlowA", "#1A2563EB");
            Paint("GlowB", "#0D38BDF8");
            Paint("FgSubtle", "#A1A1AA");
            Paint("BorderStrong", "#2A2A2A");
            Paint("PrimaryHover", "#93C5FD");
        }
        else
        {
            Paint("Bg", "#F3F6FB");
            Paint("Surface", "#FFFFFF");
            Paint("SurfaceMuted", "#F4F6F9");
            Paint("Fg", "#111827");
            Paint("Muted", "#4B5563");
            Paint("Border", "#E8EBF0");
            Paint("Primary", "#2563EB");
            Paint("PrimarySoft", "#EFF6FF");
            Paint("OnPrimary", "#FFFFFF");
            Paint("Danger", "#991B1B");
            Paint("DangerBg", "#FEF2F2");
            Paint("GlowA", "#102563EB");
            Paint("GlowB", "#0A38BDF8");
            Paint("FgSubtle", "#6B7280");
            Paint("BorderStrong", "#D5DAE3");
            Paint("PrimaryHover", "#1D4ED8");
        }

        var shadow = Current.Resources["CardShadow"] as Media.Effects.DropShadowEffect;
        var fresh = shadow == null || shadow.IsFrozen;
        if (fresh) shadow = new Media.Effects.DropShadowEffect();
        shadow!.Color = (Media.Color)Media.ColorConverter.ConvertFromString(dark ? "#000000" : "#2563EB");
        shadow.BlurRadius = dark ? 16 : 18;
        shadow.ShadowDepth = dark ? 0 : 6;
        shadow.Direction = 270;
        shadow.Opacity = dark ? 0 : 0.07;
        if (fresh) Current.Resources["CardShadow"] = shadow;
    }
}
