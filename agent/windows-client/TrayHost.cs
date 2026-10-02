using System.Drawing;
using System.Windows;
using System.Windows.Forms;

namespace Corax.Client;

public sealed class TrayHost : IDisposable
{
    readonly NotifyIcon _icon;
    readonly Window _window;

    public event EventHandler? OpenTickets;
    public event EventHandler? ExitRequested;

    public TrayHost(Window window)
    {
        _window = window;
        var menu = new ContextMenuStrip();
        menu.Items.Add("Открыть", null, (_, _) => Restore());
        menu.Items.Add("Заявка", null, (_, _) => OpenTickets?.Invoke(this, EventArgs.Empty));
        menu.Items.Add("Выход", null, (_, _) => ExitRequested?.Invoke(this, EventArgs.Empty));
        _icon = new NotifyIcon
        {
            Icon = Mark(),
            Text = "Corax",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _icon.DoubleClick += (_, _) => Restore();
    }

    void Restore()
    {
        _window.Show();
        if (_window.WindowState == WindowState.Minimized) _window.WindowState = WindowState.Normal;
        _window.Activate();
    }

    static Icon Mark()
    {
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Color.FromArgb(10, 10, 10));
            using var brush = new SolidBrush(Color.FromArgb(96, 165, 250));
            using var font = new Font("Segoe UI", 16, System.Drawing.FontStyle.Bold, GraphicsUnit.Pixel);
            g.DrawString("C", font, brush, 6, 4);
        }
        return Icon.FromHandle(bitmap.GetHicon());
    }

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
    }
}
