using System.ComponentModel;
using System.Diagnostics;
using System.Net.Sockets;
using System.Security.Principal;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace Corax.Client;

public partial class ShellWindow : Window
{
    readonly ClientSettings _settings = ClientSettings.Load();
    readonly CoraxApi _api;
    readonly TrayHost _tray;
    IReadOnlyList<DirectoryPerson> _people = Array.Empty<DirectoryPerson>();
    IReadOnlyList<PortalTab> _tabs = Array.Empty<PortalTab>();
    bool _allowExit;

    public ShellWindow()
    {
        InitializeComponent();
        _api = new CoraxApi(_settings);
        HostLabel.Text = Environment.MachineName;
        ServerBox.Text = _settings.ServerUrl;
        SecretBox.Password = _settings.HandlerSecret;
        ThemeBox.IsChecked = _settings.Dark;
        AutoBox.IsChecked = _settings.Autostart;
        Opacity = 0;
        _tray = new TrayHost(this);
        Loaded += async (_, _) =>
        {
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            BeginAnimation(OpacityProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(480)) { EasingFunction = ease });
            Rise(Root, 0.975);
            Drift(OrbA, Canvas.LeftProperty, -120, -16, 16);
            Drift(OrbA, Canvas.TopProperty, -160, -70, 19);
            Drift(OrbB, Canvas.LeftProperty, 680, 800, 22);
            Drift(OrbB, Canvas.TopProperty, -80, 30, 17);
            Breathe(OrbA, 0.78, 1, 8);
            Breathe(OrbB, 0.6, 1, 11);
            ShowPage(PageHome, "Заявки", "Коротко, что случилось. Заявка уйдёт с этого компьютера.");
            await RefreshAsync();
            FillPc();
        };
        Closed += (_, _) =>
        {
            _api.Dispose();
            _tray.Dispose();
        };
        _tray.OpenTickets += (_, _) => { Show(); Activate(); NavHome.IsChecked = true; };
        _tray.ExitRequested += (_, _) =>
        {
            _allowExit = true;
            Close();
        };
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_allowExit)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnClosing(e);
    }

    void Drag(object sender, MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed) DragMove();
    }

    void Min_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    void Close_Click(object sender, RoutedEventArgs e) => Hide();

    void Nav_Checked(object sender, RoutedEventArgs e)
    {
        if (!IsLoaded) return;
        if (ReferenceEquals(sender, NavHome)) ShowPage(PageHome, "Заявки", "Коротко, что случилось. Заявка уйдёт с этого компьютера.");
        else if (ReferenceEquals(sender, NavBook)) ShowPage(PageBook, "Справочник", "Люди из каталога панели.");
        else if (ReferenceEquals(sender, NavPc)) ShowPage(PagePc, "Этот компьютер", "Кому уйдёт заявка и как снять инвентаризацию.");
        else if (ReferenceEquals(sender, NavSettings)) ShowPage(PageSettings, "Настройки", "Адрес панели и запуск вместе с Windows.");
    }

    static void Drift(UIElement target, DependencyProperty property, double from, double to, double seconds)
    {
        target.BeginAnimation(property, new DoubleAnimation(from, to, TimeSpan.FromSeconds(seconds))
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
        });
    }

    static void Breathe(UIElement target, double from, double to, double seconds)
    {
        target.BeginAnimation(OpacityProperty, new DoubleAnimation(from, to, TimeSpan.FromSeconds(seconds))
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
        });
    }

    static void Rise(FrameworkElement root, double from)
    {
        root.RenderTransformOrigin = new System.Windows.Point(0.5, 0.42);
        var scale = new ScaleTransform(from, from);
        root.RenderTransform = scale;
        var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
        var duration = TimeSpan.FromMilliseconds(520);
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(from, 1, duration) { EasingFunction = ease });
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(from, 1, duration) { EasingFunction = ease });
    }

    void ShowPage(UIElement page, string title, string lead)
    {
        foreach (var item in new UIElement[] { PageHome, PageBook, PagePc, PageSettings, PagePortal })
            item.Visibility = ReferenceEquals(item, page) ? Visibility.Visible : Visibility.Collapsed;
        PageTitle.Text = title;
        PageLead.Text = lead;
        var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
        page.RenderTransformOrigin = new System.Windows.Point(0, 0);
        var shift = new TranslateTransform(0, 14);
        page.RenderTransform = shift;
        page.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(340)) { EasingFunction = ease });
        shift.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(14, 0, TimeSpan.FromMilliseconds(460)) { EasingFunction = ease });
        PageTitle.BeginAnimation(OpacityProperty, new DoubleAnimation(0.35, 1, TimeSpan.FromMilliseconds(280)) { EasingFunction = ease });
    }

    async Task RefreshAsync()
    {
        try
        {
            var context = await _api.ContextAsync();
            FormNote.Text = context.Requester is { Length: > 0 } who ? "От " + who : "С компьютера " + Environment.MachineName;
            PcRequester.Text = context.Requester is { Length: > 0 } person
                ? person + (context.Location is { Length: > 0 } place ? " · " + place : "")
                : "Панель ещё не знает, кто сидит за этим компьютером";
            var tickets = await _api.TicketsAsync();
            TicketList.ItemsSource = tickets.Select(TicketCard).ToList();
            EmptyTickets.Visibility = tickets.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _people = await _api.DirectoryAsync();
            ApplyPeople();
            _tabs = await _api.TabsAsync();
            RenderPortalNav();
            Toast.Visibility = Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            ShowError(ex.Message);
        }
    }

    void ApplyPeople()
    {
        var query = (SearchBox.Text ?? "").Trim();
        var rows = _people.Where(p =>
            query.Length == 0
            || p.Name.Contains(query, StringComparison.OrdinalIgnoreCase)
            || p.Phone.Contains(query, StringComparison.OrdinalIgnoreCase)
            || p.Email.Contains(query, StringComparison.OrdinalIgnoreCase)
            || p.Username.Contains(query, StringComparison.OrdinalIgnoreCase));
        var cards = rows.Select(PersonCard).ToList();
        PeopleList.ItemsSource = cards;
        EmptyPeople.Visibility = cards.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    void Search_Changed(object sender, TextChangedEventArgs e) => ApplyPeople();

    void RenderPortalNav()
    {
        ExtraNav.Children.Clear();
        foreach (var tab in _tabs)
        {
            var btn = new RadioButton
            {
                Content = tab.Title,
                GroupName = "MainNav",
                Tag = tab,
                Style = (Style)FindResource("NavButton"),
            };
            btn.Checked += PortalNav_Checked;
            ExtraNav.Children.Add(btn);
        }
    }

    void PortalNav_Checked(object sender, RoutedEventArgs e)
    {
        if (!IsLoaded) return;
        if (sender is RadioButton { Tag: PortalTab tab }) ShowPortal(tab);
    }

    void ShowPortal(PortalTab tab)
    {
        ShowPage(PagePortal, tab.Title, "");
        var isText = tab.Kind != "table";
        PortalBody.Text = isText
            ? (string.IsNullOrWhiteSpace(tab.Body)
                ? "Пока нет текста. Администратор заполнит вкладку в настройках агента."
                : tab.Body)
            : "";
        PortalBody.Visibility = isText ? Visibility.Visible : Visibility.Collapsed;
        FillPortalGrid(tab);
    }

    void FillPortalGrid(PortalTab tab)
    {
        PortalGrid.Children.Clear();
        PortalGrid.RowDefinitions.Clear();
        PortalGrid.ColumnDefinitions.Clear();
        if (tab.Kind != "table")
        {
            PortalTableWrap.Visibility = Visibility.Collapsed;
            return;
        }
        PortalTableWrap.Visibility = Visibility.Visible;
        var cols = tab.Columns.Count == 0 ? new List<string> { " " } : tab.Columns.ToList();
        foreach (var _ in cols)
            PortalGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        PortalGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        for (var c = 0; c < cols.Count; c++)
        {
            var head = new TextBlock
            {
                Text = cols[c],
                FontWeight = FontWeights.SemiBold,
                FontSize = 12,
                Margin = new Thickness(6, 4, 6, 8),
                Foreground = (Brush)FindResource("Muted"),
            };
            Grid.SetRow(head, 0);
            Grid.SetColumn(head, c);
            PortalGrid.Children.Add(head);
        }
        for (var r = 0; r < tab.Rows.Count; r++)
        {
            PortalGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            for (var c = 0; c < cols.Count; c++)
            {
                var cell = c < tab.Rows[r].Count ? tab.Rows[r][c] : "";
                var block = new TextBlock
                {
                    Text = cell.Length > 0 ? cell : "—",
                    FontSize = 13,
                    Margin = new Thickness(6, 3, 6, 3),
                    TextWrapping = TextWrapping.Wrap,
                    Foreground = (Brush)FindResource("Fg"),
                };
                Grid.SetRow(block, r + 1);
                Grid.SetColumn(block, c);
                PortalGrid.Children.Add(block);
            }
        }
    }

    async void Send_Click(object sender, RoutedEventArgs e)
    {
        var title = TitleBox.Text.Trim();
        var body = BodyBox.Text.Trim();
        if (title.Length < 3 || body.Length < 3)
        {
            ShowError("Нужны тема и описание, хотя бы по несколько слов");
            return;
        }
        SendButton.IsEnabled = false;
        try
        {
            var message = await _api.CreateTicketAsync(title, body);
            TitleBox.Clear();
            BodyBox.Clear();
            await RefreshAsync();
            FormNote.Text = message;
        }
        catch (Exception ex)
        {
            ShowError(ex.Message);
        }
        finally
        {
            SendButton.IsEnabled = true;
        }
    }

    void Collect_Click(object sender, RoutedEventArgs e)
    {
        var agent = MachineInstall.FindInventoryAgent();
        if (agent == null)
        {
            CollectNote.Text = "Агент инвентаризации ещё не установлен. Его скачивает администратор из панели.";
            return;
        }
        Process.Start(new ProcessStartInfo(agent) { UseShellExecute = true });
        CollectNote.Text = "Агент запущен. Список оборудования обновится на панели.";
    }

    void Theme_Changed(object sender, RoutedEventArgs e)
    {
        if (!IsLoaded) return;
        App.ApplyTheme(ThemeBox.IsChecked == true);
    }

    void Save_Click(object sender, RoutedEventArgs e)
    {
        _settings.ServerUrl = ServerBox.Text.Trim().TrimEnd('/');
        _settings.HandlerSecret = SecretBox.Password.Trim();
        _settings.Dark = ThemeBox.IsChecked == true;
        _settings.Autostart = AutoBox.IsChecked == true;
        try
        {
            _settings.Save();
            MachineInstall.SetAutostart(_settings.Autostart);
            FormNote.Text = "Настройки сохранены";
            _ = RefreshAsync();
        }
        catch (Exception ex)
        {
            ShowError(ex.Message);
        }
    }

    void DismissToast(object sender, RoutedEventArgs e) => Toast.Visibility = Visibility.Collapsed;

    void ShowError(string message)
    {
        ToastText.Text = message;
        Toast.Visibility = Visibility.Visible;
    }

    void FillPc()
    {
        PcName.Text = Environment.MachineName;
        try
        {
            PcUser.Text = WindowsIdentity.GetCurrent().Name;
        }
        catch (Exception)
        {
            PcUser.Text = Environment.UserName;
        }
        PcAddress.Text = LocalAddress();
        var agent = MachineInstall.FindInventoryAgent();
        CollectNote.Text = agent == null
            ? "Кнопка запустит уже установленный агент инвентаризации."
            : "Агент на месте: " + agent;
    }

    static string LocalAddress()
    {
        try
        {
            var host = System.Net.Dns.GetHostEntry(System.Net.Dns.GetHostName());
            var ip = host.AddressList.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork);
            return ip?.ToString() ?? "—";
        }
        catch (Exception)
        {
            return "—";
        }
    }

    static Border TicketCard(TicketItem item)
    {
        var title = new TextBlock { Text = item.Title, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis };
        title.SetResourceReference(TextBlock.ForegroundProperty, "Fg");
        var meta = new TextBlock { Text = string.Join("  ·  ", new[] { item.Number, item.StatusLabel, item.When }.Where(s => s.Length > 0)), Margin = new Thickness(0, 3, 0, 0), FontSize = 12 };
        meta.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        var stack = new StackPanel();
        stack.Children.Add(title);
        stack.Children.Add(meta);
        var card = new Border { CornerRadius = new CornerRadius(12), Padding = new Thickness(12, 10, 12, 10), Margin = new Thickness(0, 0, 0, 8), BorderThickness = new Thickness(1), Child = stack };
        card.SetResourceReference(Border.BackgroundProperty, "Surface");
        card.SetResourceReference(Border.BorderBrushProperty, "Border");
        card.SetResourceReference(Border.EffectProperty, "CardShadow");
        return card;
    }

    static Border PersonCard(DirectoryPerson person)
    {
        var mark = new Border { Width = 36, Height = 36, CornerRadius = new CornerRadius(8), Margin = new Thickness(0, 0, 12, 0) };
        mark.SetResourceReference(Border.BackgroundProperty, "PrimarySoft");
        var initials = new TextBlock { Text = person.Initials, FontWeight = FontWeights.SemiBold, HorizontalAlignment = System.Windows.HorizontalAlignment.Center, VerticalAlignment = System.Windows.VerticalAlignment.Center };
        initials.SetResourceReference(TextBlock.ForegroundProperty, "Primary");
        mark.Child = initials;
        var name = new TextBlock { Text = person.Name, FontWeight = FontWeights.SemiBold };
        name.SetResourceReference(TextBlock.ForegroundProperty, "Fg");
        var line = new TextBlock { Text = person.Line, Margin = new Thickness(0, 2, 0, 0), FontSize = 12 };
        line.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
        var text = new StackPanel { VerticalAlignment = System.Windows.VerticalAlignment.Center };
        text.Children.Add(name);
        text.Children.Add(line);
        var row = new DockPanel();
        DockPanel.SetDock(mark, Dock.Left);
        row.Children.Add(mark);
        row.Children.Add(text);
        var card = new Border { CornerRadius = new CornerRadius(12), Padding = new Thickness(12), Margin = new Thickness(0, 0, 0, 8), BorderThickness = new Thickness(1), Child = row };
        card.SetResourceReference(Border.BackgroundProperty, "Surface");
        card.SetResourceReference(Border.BorderBrushProperty, "Border");
        card.SetResourceReference(Border.EffectProperty, "CardShadow");
        return card;
    }
}
