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
            var fade = new Media.Animation.ColorAnimation(color, TimeSpan.FromMilliseconds(360))
            {
                EasingFunction = new Media.Animation.CubicEase { EasingMode = Media.Animation.EasingMode.EaseOut },
            };
            if (Current.Resources[key] is Media.SolidColorBrush brush && !brush.IsFrozen)
            {
                brush.BeginAnimation(Media.SolidColorBrush.ColorProperty, fade);
                return;
            }
            var created = new Media.SolidColorBrush(color);
            Current.Resources[key] = created;
            created.BeginAnimation(Media.SolidColorBrush.ColorProperty, fade);
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
            Paint("GlowA", "#332563EB");
            Paint("GlowB", "#1A38BDF8");
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
            Paint("GlowA", "#1F2563EB");
            Paint("GlowB", "#1438BDF8");
            Paint("FgSubtle", "#6B7280");
            Paint("BorderStrong", "#D5DAE3");
            Paint("PrimaryHover", "#1D4ED8");
        }

        var shadow = Current.Resources["CardShadow"] as Media.Effects.DropShadowEffect;
        if (shadow == null || shadow.IsFrozen)
        {
            shadow = new Media.Effects.DropShadowEffect();
            Current.Resources["CardShadow"] = shadow;
        }
        shadow.Color = (Media.Color)Media.ColorConverter.ConvertFromString(dark ? "#000000" : "#2563EB");
        shadow.BlurRadius = dark ? 16 : 32;
        shadow.ShadowDepth = dark ? 0 : 12;
        shadow.Direction = 270;
        shadow.BeginAnimation(
            Media.Effects.DropShadowEffect.OpacityProperty,
            new Media.Animation.DoubleAnimation(dark ? 0 : 0.12, TimeSpan.FromMilliseconds(360))
            {
                EasingFunction = new Media.Animation.CubicEase { EasingMode = Media.Animation.EasingMode.EaseOut },
            });
    }
}
