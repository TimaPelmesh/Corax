using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace Corax.Client;

public partial class InstallWindow : Window
{
    public InstallWindow()
    {
        InitializeComponent();
        Opacity = 0;
        Loaded += (_, _) =>
        {
            var settings = ClientSettings.Load();
            SplitServer(settings.ServerUrl, out var host, out var port);
            HostBox.Text = host;
            if (port.Length > 0) PortBox.Text = port;
            TokenBox.Password = settings.HandlerSecret;
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(480)) { EasingFunction = ease });
            Root.RenderTransformOrigin = new System.Windows.Point(0.5, 0.42);
            var scale = new ScaleTransform(0.96, 0.96);
            Root.RenderTransform = scale;
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.96, 1, TimeSpan.FromMilliseconds(560)) { EasingFunction = ease });
            scale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.96, 1, TimeSpan.FromMilliseconds(560)) { EasingFunction = ease });
            Drift(OrbA, Canvas.LeftProperty, -80, 10, 14);
            Drift(OrbA, Canvas.TopProperty, -100, -40, 17);
            Drift(OrbB, Canvas.LeftProperty, 210, 270, 18);
            Drift(OrbB, Canvas.TopProperty, 0, 48, 15);
            Breathe(OrbA, 0.75, 1, 7);
            Breathe(OrbB, 0.6, 1, 9);
        };
    }

    void Drag(object sender, MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed) DragMove();
    }

    void Close_Click(object sender, RoutedEventArgs e) => Close();

    async void Install_Click(object sender, RoutedEventArgs e)
    {
        var server = ComposeServer(HostBox.Text, PortBox.Text);
        if (server.Length == 0)
        {
            Status.Text = "Укажите сервер и порт";
            return;
        }
        InstallButton.IsEnabled = false;
        Bar.Visibility = Visibility.Visible;
        try
        {
            var settings = ClientSettings.Load();
            settings.ServerUrl = server;
            settings.HandlerSecret = TokenBox.Password.Trim();
            settings.Autostart = AutostartBox.IsChecked == true;
            settings.Save();
            Status.Text = "Копируем программу";
            await AnimateBar(35);
            MachineInstall.Install(settings.Autostart);
            Status.Text = "Ярлык и автозапуск";
            await AnimateBar(100);
            Status.Text = "Готово";
            await Task.Delay(280);
            MachineInstall.LaunchInstalled();
            Close();
        }
        catch (Exception ex)
        {
            Status.Text = ex.Message;
            InstallButton.IsEnabled = true;
        }
    }

    static string ComposeServer(string host, string port)
    {
        host = host.Trim().TrimEnd('/');
        if (host.Length == 0) return "";
        if (host.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || host.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return host;
        var p = port.Trim();
        if (p.Length == 0) p = "3000";
        return "http://" + host + ":" + p;
    }

    static void SplitServer(string server, out string host, out string port)
    {
        host = "";
        port = "";
        if (!Uri.TryCreate(server, UriKind.Absolute, out var uri)) return;
        host = uri.Host;
        if (!uri.IsDefaultPort) port = uri.Port.ToString();
    }

    static void Drift(System.Windows.UIElement target, System.Windows.DependencyProperty property, double from, double to, double seconds)
    {
        target.BeginAnimation(property, new DoubleAnimation(from, to, TimeSpan.FromSeconds(seconds))
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
        });
    }

    static void Breathe(System.Windows.UIElement target, double from, double to, double seconds)
    {
        target.BeginAnimation(System.Windows.UIElement.OpacityProperty, new DoubleAnimation(from, to, TimeSpan.FromSeconds(seconds))
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
        });
    }

    Task AnimateBar(double target)
    {
        var done = new TaskCompletionSource();
        var animation = new DoubleAnimation(Bar.Value, target, TimeSpan.FromMilliseconds(420))
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        animation.Completed += (_, _) => done.TrySetResult();
        Bar.BeginAnimation(System.Windows.Controls.Primitives.RangeBase.ValueProperty, animation);
        return done.Task;
    }
}
