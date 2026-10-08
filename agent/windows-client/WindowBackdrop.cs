using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using Media = System.Windows.Media;

namespace Corax.Client;

static class WindowBackdrop
{
    public static bool Mica { get; private set; }

    public static void Attach(Window window)
    {
        window.SourceInitialized += (_, _) => Apply(window);
        window.StateChanged += (_, _) => Apply(window);
    }

    public static void Apply(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero) return;

        var dark = DarkFromTheme();
        var immersive = dark ? 1 : 0;
        DwmSetWindowAttribute(hwnd, 20, ref immersive, sizeof(int));

        var corners = window.WindowState == WindowState.Maximized ? 1 : 2;
        DwmSetWindowAttribute(hwnd, 33, ref corners, sizeof(int));

        Mica = false;
        if (Build() >= 22000)
        {
            var type = 2;
            if (DwmSetWindowAttribute(hwnd, 38, ref type, sizeof(int)) == 0)
            {
                var margins = new Margins { cxLeftWidth = -1 };
                if (DwmExtendFrameIntoClientArea(hwnd, ref margins) == 0)
                {
                    Mica = true;
                    window.Background = Media.Brushes.Transparent;
                }
            }
        }
        if (!Mica && window.TryFindResource("Bg") is Media.Brush solid)
            window.Background = solid;
    }

    public static void RefreshOpenWindows()
    {
        if (System.Windows.Application.Current == null) return;
        foreach (Window window in System.Windows.Application.Current.Windows)
            Apply(window);
    }

    static bool DarkFromTheme()
    {
        return System.Windows.Application.Current?.TryFindResource("Fg") is Media.SolidColorBrush { Color.R: > 160 };
    }

    static int Build()
    {
        var info = new OsVersionInfo { dwOSVersionInfoSize = Marshal.SizeOf<OsVersionInfo>() };
        RtlGetVersion(ref info);
        return info.dwBuildNumber;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Margins
    {
        public int cxLeftWidth;
        public int cxRightWidth;
        public int cyTopHeight;
        public int cyBottomHeight;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct OsVersionInfo
    {
        public int dwOSVersionInfoSize;
        public int dwMajorVersion;
        public int dwMinorVersion;
        public int dwBuildNumber;
        public int dwPlatformId;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szCSDVersion;
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("dwmapi.dll")]
    static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref Margins margins);

    [DllImport("ntdll.dll")]
    static extern int RtlGetVersion(ref OsVersionInfo info);
}
