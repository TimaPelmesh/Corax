using System.Windows;
using System.Windows.Input;
using System.Windows.Media.Animation;

namespace Corax.Client;

public partial class InstallWindow : Window
{
    public InstallWindow()
    {
        InitializeComponent();
        Opacity = 0;
        WindowBackdrop.Attach(this);
        Loaded += (_, _) =>
        {
            var settings = ClientSettings.Load();
            SplitServer(settings.ServerUrl, out var host, out var port);
            HostBox.Text = host;
            if (port.Length > 0) PortBox.Text = port;
            TokenBox.Password = settings.HandlerSecret;
            BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(180)));
            HostBox.Focus();
        };
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
            await Task.Delay(220);
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

    Task AnimateBar(double target)
    {
        var done = new TaskCompletionSource();
        var animation = new DoubleAnimation(Bar.Value, target, TimeSpan.FromMilliseconds(280))
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        animation.Completed += (_, _) => done.TrySetResult();
        Bar.BeginAnimation(System.Windows.Controls.Primitives.RangeBase.ValueProperty, animation);
        return done.Task;
    }
}
