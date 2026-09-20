use crate::config::{load_config, next_report_label, save_user_prefs};
use crate::shortcut::create_helpdesk_shortcut;
use crate::state::{Flags, RunOutcome, SharedState};
use eframe::egui::{
    self, Color32, CornerRadius, FontId, Frame, Margin, Pos2, Rect, RichText, Sense,
    Stroke, TextureHandle, Ui, Vec2, ViewportCommand,
};
use std::sync::atomic::Ordering;
use std::sync::mpsc::SyncSender;
use tray_icon::menu::{Menu, MenuEvent, MenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

#[cfg(windows)]
mod win_show {
    type Hwnd = *mut std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, name: *const u16) -> Hwnd;
        fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
        fn SetForegroundWindow(hwnd: Hwnd) -> i32;
    }
    pub fn restore() {
        const SW_RESTORE: i32 = 9;
        unsafe {
            let title: Vec<u16> = "CORAX\0".encode_utf16().collect();
            let hwnd = FindWindowW(std::ptr::null(), title.as_ptr());
            if !hwnd.is_null() {
                ShowWindow(hwnd, SW_RESTORE);
                SetForegroundWindow(hwnd);
            }
        }
    }
}

fn reveal_window(ctx: &egui::Context) {
    ctx.send_viewport_cmd(ViewportCommand::Visible(true));
    ctx.send_viewport_cmd(ViewportCommand::Minimized(false));
    ctx.send_viewport_cmd(ViewportCommand::Focus);
    ctx.send_viewport_cmd(ViewportCommand::RequestUserAttention(
        egui::UserAttentionType::Informational,
    ));
    ctx.request_repaint();
    #[cfg(windows)]
    win_show::restore();
}

fn wire_tray_handlers(ctx: egui::Context, flags: Flags, kick: SyncSender<()>) {
    let ctx_click = ctx.clone();
    let flags_click = flags.clone();
    TrayIconEvent::set_event_handler(Some(move |ev: TrayIconEvent| {
        match ev {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                flags_click.request_show();
                reveal_window(&ctx_click);
            }
            _ => {}
        }
    }));
    MenuEvent::set_event_handler(Some(move |ev: MenuEvent| match ev.id.0.as_str() {
        "open" => {
            flags.request_show();
            reveal_window(&ctx);
        }
        "settings" => {
            flags.request_settings();
            reveal_window(&ctx);
        }
        "collect" => {
            let _ = kick.try_send(());
            ctx.request_repaint();
        }
        "quit" => std::process::exit(0),
        _ => {}
    }));
}

const BG: Color32 = Color32::from_rgb(236, 244, 255);
const CARD: Color32 = Color32::WHITE;
const CARD_HI: Color32 = Color32::from_rgb(247, 250, 255);
const LINE: Color32 = Color32::from_rgb(210, 224, 244);
const TEXT: Color32 = Color32::from_rgb(15, 23, 42);
const MUTED: Color32 = Color32::from_rgb(100, 116, 139);
const ACCENT: Color32 = Color32::from_rgb(37, 99, 235);
const PEACH: Color32 = Color32::from_rgb(251, 146, 60);
const OK: Color32 = Color32::from_rgb(16, 185, 129);
const BAD: Color32 = Color32::from_rgb(239, 68, 68);
const WARN: Color32 = Color32::from_rgb(245, 158, 11);
const ON_ACCENT: Color32 = Color32::WHITE;

fn load_tray_icon(bytes: &[u8]) -> Icon {
    let img = image::load_from_memory(bytes)
        .expect("icon png")
        .into_rgba8();
    let (w, h) = img.dimensions();
    Icon::from_rgba(img.into_raw(), w, h).expect("rgba icon")
}

fn load_color_image(bytes: &[u8]) -> egui::ColorImage {
    let img = image::load_from_memory(bytes)
        .expect("ui png")
        .into_rgba8();
    let size = [img.width() as usize, img.height() as usize];
    egui::ColorImage::from_rgba_unmultiplied(size, &img.into_raw())
}

pub struct CoraxApp {
    state: SharedState,
    kick: SyncSender<()>,
    flags: Flags,
    tray: Option<TrayIcon>,
    idle_icon: Icon,
    busy_icon: Icon,
    logo: Option<TextureHandle>,
    last_outcome: Option<RunOutcome>,
    tab: u8,
    host: String,
    port: String,
    https: bool,
    daily_hour: u32,
    daily_minute: u32,
    autostart: bool,
    shortcut_note: String,
}

impl CoraxApp {
    pub fn new(
        cc: &eframe::CreationContext<'_>,
        state: SharedState,
        kick: SyncSender<()>,
        flags: Flags,
    ) -> Self {
        apply_theme(&cc.egui_ctx);
        wire_tray_handlers(cc.egui_ctx.clone(), flags.clone(), kick.clone());
        let idle_icon = load_tray_icon(include_bytes!("../icons/32x32.png"));
        let busy_icon = load_tray_icon(include_bytes!("../icons/tray-busy.png"));
        let open = MenuItem::with_id("open", "Открыть CORAX", true, None);
        let collect = MenuItem::with_id("collect", "Собрать сейчас", true, None);
        let settings = MenuItem::with_id("settings", "Настройки", true, None);
        let quit = MenuItem::with_id("quit", "Выход", true, None);
        let menu = Menu::new();
        let _ = menu.append(&open);
        let _ = menu.append(&collect);
        let _ = menu.append(&settings);
        let _ = menu.append(&quit);
        let tray = TrayIconBuilder::new()
            .with_icon(idle_icon.clone())
            .with_tooltip("CORAX · инвентарь")
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(false)
            .build()
            .ok();
        let cfg = load_config();
        let (host, port, https) = split_server(&cfg.server_url);
        Self {
            state,
            kick,
            flags,
            tray,
            idle_icon,
            busy_icon,
            logo: None,
            last_outcome: None,
            tab: if cfg.server_url.is_empty() { 2 } else { 0 },
            host,
            port,
            https,
            daily_hour: cfg.daily_hour,
            daily_minute: cfg.daily_minute,
            autostart: cfg.autostart,
            shortcut_note: String::new(),
        }
    }

    fn sync_tray(&mut self, collecting: bool, outcome: RunOutcome) {
        let Some(tray) = self.tray.as_ref() else { return };
        if collecting {
            let _ = tray.set_icon(Some(self.busy_icon.clone()));
            let _ = tray.set_tooltip(Some("CORAX · сбор инвентаря"));
            return;
        }
        if self.last_outcome == Some(outcome) {
            let _ = tray.set_icon(Some(self.idle_icon.clone()));
        } else {
            let _ = tray.set_icon(Some(self.idle_icon.clone()));
            self.last_outcome = Some(outcome);
        }
        let tip = match outcome {
            RunOutcome::Sent => "CORAX · инвентарь OK",
            RunOutcome::NeedConfig => "CORAX · укажите сервер",
            RunOutcome::Failed => "CORAX · ошибка отчёта",
        };
        let _ = tray.set_tooltip(Some(tip));
    }

    fn quit_now(&mut self) -> ! {
        if let Some(tray) = self.tray.take() {
            drop(tray);
        }
        std::process::exit(0);
    }
}

impl eframe::App for CoraxApp {
    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        BG.to_normalized_gamma_f32()
    }

    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if self.flags.quit.load(Ordering::SeqCst) {
            self.quit_now();
        }
        if ctx.input(|i| i.viewport().close_requested()) {
            ctx.send_viewport_cmd(ViewportCommand::CancelClose);
            ctx.send_viewport_cmd(ViewportCommand::Visible(false));
        }
        if self.flags.show.swap(false, Ordering::SeqCst) {
            ctx.send_viewport_cmd(ViewportCommand::Visible(true));
            ctx.send_viewport_cmd(ViewportCommand::Minimized(false));
            ctx.send_viewport_cmd(ViewportCommand::Focus);
            ctx.send_viewport_cmd(ViewportCommand::RequestUserAttention(
                egui::UserAttentionType::Informational,
            ));
        }

        while let Ok(ev) = TrayIconEvent::receiver().try_recv() {
            match ev {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => self.flags.request_show(),
                _ => {}
            }
        }
        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            match ev.id.0.as_str() {
                "open" => self.flags.request_show(),
                "settings" => {
                    self.tab = 1;
                    self.flags.request_settings();
                }
                "collect" => {
                    let _ = self.kick.try_send(());
                }
                "quit" => self.quit_now(),
                _ => {}
            }
        }

        if self.flags.settings.swap(false, Ordering::SeqCst) {
            self.tab = 1;
        }

        let (collecting, snap) = {
            let g = self.state.lock().expect("state");
            (g.collecting, g.last.clone())
        };
        self.sync_tray(collecting, snap.outcome);

        if self.logo.is_none() {
            let img = load_color_image(include_bytes!("../icons/128x128.png"));
            self.logo = Some(ctx.load_texture("raven", img, egui::TextureOptions::LINEAR));
        }

        egui::CentralPanel::default()
            .frame(Frame::NONE.fill(BG).inner_margin(Margin::same(0)))
            .show(ctx, |ui| {
                draw_chrome(ui, ctx, &mut self.tab);
                ui.add_space(4.0);
                ui.allocate_ui_with_layout(
                    ui.available_size(),
                    egui::Layout::top_down(egui::Align::Center),
                    |ui| {
                        ui.set_max_width(380.0);
                        if self.tab == 2 || (self.host.is_empty() && load_config().server_url.is_empty()) {
                            self.tab = 2;
                            setup_panel(ui, self);
                        } else if self.tab == 1 {
                            settings_panel(ui, self);
                        } else {
                            hero(ui, self.logo.as_ref(), collecting, ctx);
                            ui.add_space(18.0);
                            status_card(ui, collecting, &snap);
                            ui.add_space(12.0);
                            specs_card(ui, &snap);
                            ui.add_space(18.0);
                            collect_button(ui, collecting, &self.kick);
                            ui.add_space(14.0);
                            footer(ui, &snap, collecting);
                        }
                    },
                );
            });

        if collecting {
            ctx.request_repaint();
        } else {
            ctx.request_repaint_after(std::time::Duration::from_millis(400));
        }
    }
}

fn apply_theme(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::light();
    visuals.panel_fill = BG;
    visuals.window_fill = CARD;
    visuals.extreme_bg_color = Color32::WHITE;
    visuals.faint_bg_color = CARD_HI;
    visuals.override_text_color = Some(TEXT);
    visuals.hyperlink_color = ACCENT;
    visuals.selection.bg_fill = Color32::from_rgb(219, 234, 254);
    visuals.selection.stroke = Stroke::new(1.0_f32, ACCENT);
    visuals.widgets.noninteractive.bg_fill = CARD;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, MUTED);
    visuals.widgets.inactive.bg_fill = Color32::WHITE;
    visuals.widgets.inactive.weak_bg_fill = Color32::WHITE;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, LINE);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT);
    visuals.widgets.hovered.bg_fill = Color32::from_rgb(239, 246, 255);
    visuals.widgets.hovered.weak_bg_fill = Color32::from_rgb(239, 246, 255);
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, ACCENT);
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, TEXT);
    visuals.widgets.active.bg_fill = ACCENT;
    visuals.widgets.active.fg_stroke = Stroke::new(1.0_f32, ON_ACCENT);
    visuals.widgets.open.bg_fill = Color32::WHITE;
    visuals.window_corner_radius = CornerRadius::same(16);
    visuals.widgets.inactive.corner_radius = CornerRadius::same(10);
    visuals.widgets.hovered.corner_radius = CornerRadius::same(10);
    visuals.widgets.active.corner_radius = CornerRadius::same(10);
    visuals.window_shadow = egui::Shadow::NONE;
    visuals.popup_shadow = egui::Shadow::NONE;
    ctx.set_visuals(visuals);
}

fn draw_chrome(ui: &mut Ui, ctx: &egui::Context, tab: &mut u8) {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 40.0), Sense::click_and_drag());
    if resp.dragged() {
        ctx.send_viewport_cmd(ViewportCommand::StartDrag);
    }
    ui.painter().text(
        Pos2::new(rect.left() + 18.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        "CORAX",
        FontId::proportional(14.0),
        ACCENT,
    );
    ui.painter()
        .hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0_f32, LINE));
    let gear = icon_hit(ui, rect, -118.0, "⚙");
    let hide = icon_hit(ui, rect, -76.0, "–");
    let close = icon_hit(ui, rect, -28.0, "×");
    if gear.clicked() {
        *tab = if *tab == 1 { 0 } else { 1 };
    }
    if hide.clicked() || close.clicked() {
        ctx.send_viewport_cmd(ViewportCommand::Visible(false));
    }
}

fn icon_hit(ui: &mut Ui, bar: Rect, x_from_right: f32, glyph: &str) -> egui::Response {
    let c = Pos2::new(bar.right() + x_from_right, bar.center().y);
    let r = Rect::from_center_size(c, Vec2::splat(28.0));
    let resp = ui.allocate_rect(r, Sense::click());
    let fill = if resp.hovered() {
        Color32::from_rgba_unmultiplied(251, 146, 60, 40)
    } else {
        Color32::TRANSPARENT
    };
    ui.painter()
        .rect_filled(r, CornerRadius::same(8), fill);
    ui.painter().text(
        c,
        egui::Align2::CENTER_CENTER,
        glyph,
        FontId::proportional(18.0),
        if resp.hovered() { TEXT } else { MUTED },
    );
    resp
}

fn hero(ui: &mut Ui, logo: Option<&TextureHandle>, collecting: bool, ctx: &egui::Context) {
    let t = ctx.input(|i| i.time);
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(112.0), Sense::hover());
    let c = rect.center();
    let pulse = if collecting {
        ((t * 3.2).sin() as f32 + 1.0) * 0.5
    } else {
        0.12
    };
    ui.painter().circle_filled(
        c,
        52.0 + pulse * 7.0,
        Color32::from_rgba_unmultiplied(251, 146, 60, (10.0 + pulse * 18.0) as u8),
    );
    ui.painter().circle_filled(
        c,
        46.0 + pulse * 5.0,
        Color32::from_rgba_unmultiplied(37, 99, 235, (16.0 + pulse * 28.0) as u8),
    );
    ui.painter().circle_stroke(
        c,
        42.0 + pulse * 3.0,
        Stroke::new(1.2_f32, Color32::from_rgba_unmultiplied(37, 99, 235, (40.0 + pulse * 70.0) as u8)),
    );
    if let Some(tex) = logo {
        let logo_r = Rect::from_center_size(c, Vec2::splat(72.0));
        egui::Image::new(tex)
            .corner_radius(CornerRadius::same(18))
            .paint_at(ui, logo_r);
    }
    ui.add_space(6.0);
    ui.label(RichText::new("этот компьютер").size(12.0).color(ACCENT).strong());
}

fn status_card(ui: &mut Ui, collecting: bool, snap: &crate::state::Snapshot) {
    let (title, sub, color) = if collecting {
        (
            "Собираю этот ПК".to_string(),
            "Железо, диски, софт, аудио, мониторы".to_string(),
            ACCENT,
        )
    } else {
        match snap.outcome {
            RunOutcome::Sent => (
                "Всё отправлено".into(),
                if snap.at.is_empty() {
                    "Отчёт на сервере".into()
                } else {
                    format!("Последний отчёт  {}", snap.at)
                },
                OK,
            ),
            RunOutcome::NeedConfig => (
                "Укажите адрес сервера".into(),
                "Токен уже вшит. Нужен только IP CORAX".into(),
                WARN,
            ),
            RunOutcome::Failed => (
                "Отчёт не ушёл".into(),
                if snap.detail.is_empty() {
                    "Проверьте сервер и токен".into()
                } else {
                    snap.detail.clone()
                },
                BAD,
            ),
        }
    };
    Frame::new()
        .fill(CARD)
        .stroke(Stroke::new(1.0_f32, LINE))
        .corner_radius(CornerRadius::same(16))
        .inner_margin(Margin::symmetric(18, 16))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                let (dot, _) = ui.allocate_exact_size(Vec2::splat(10.0), Sense::hover());
                ui.painter().circle_filled(dot.center(), 5.0, color);
                ui.add_space(8.0);
                ui.vertical(|ui| {
                    ui.label(RichText::new(title).size(18.0).color(TEXT).strong());
                    ui.add_space(2.0);
                    ui.label(RichText::new(sub).size(12.5).color(MUTED));
                });
            });
        });
}

fn specs_card(ui: &mut Ui, snap: &crate::state::Snapshot) {
    Frame::new()
        .fill(CARD)
        .stroke(Stroke::new(1.0_f32, LINE))
        .corner_radius(CornerRadius::same(16))
        .inner_margin(Margin::symmetric(18, 14))
        .show(ui, |ui| {
            ui.label(RichText::new(snap.hostname.to_uppercase()).size(13.0).color(ACCENT).strong());
            ui.add_space(8.0);
            spec(ui, "процессор", &snap.cpu);
            spec(ui, "память", &snap.ram);
            spec(ui, "система", &snap.os);
            spec(ui, "видео", &snap.gpu);
            spec(ui, "модель", &snap.model);
            spec(ui, "диски", &snap.disks);
            spec(ui, "программы", &snap.software);
            spec(ui, "периферия", &snap.peripherals);
            spec(ui, "мониторы", &snap.monitors);
            spec(ui, "аудио", &snap.audio);
        });
}

fn spec(ui: &mut Ui, k: &str, v: &str) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(k).size(12.0).color(MUTED));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(
                RichText::new(truncate(v, 32))
                    .size(12.5)
                    .color(TEXT),
            );
        });
    });
    ui.add_space(3.0);
}

fn truncate(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        t.to_string()
    } else {
        let cut: String = t.chars().take(n.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

fn collect_button(ui: &mut Ui, collecting: bool, kick: &SyncSender<()>) {
    let label = if collecting {
        "Сбор…"
    } else {
        "Собрать сейчас"
    };
    let btn = egui::Button::new(RichText::new(label).size(16.0).color(ON_ACCENT).strong())
        .fill(if collecting { Color32::from_rgb(147, 197, 253) } else { ACCENT })
        .corner_radius(CornerRadius::same(22))
        .min_size(Vec2::new(ui.available_width(), 50.0));
    let resp = ui.add_enabled(!collecting, btn);
    if resp.hovered() && !collecting {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    if resp.clicked() {
        let _ = kick.try_send(());
    }
}

fn footer(ui: &mut Ui, snap: &crate::state::Snapshot, collecting: bool) {
    let server = if snap.server.is_empty() {
        "сервер не задан"
    } else {
        snap.server.as_str()
    };
    ui.label(RichText::new(server).size(11.0).color(MUTED));
    if !collecting && snap.outcome != RunOutcome::NeedConfig {
        ui.label(
            RichText::new(format!("следующий отчёт  {}", next_report_label(&load_config())))
                .size(11.0)
                .color(MUTED),
        );
    }
}

fn split_server(url: &str) -> (String, String, bool) {
    let u = url.trim();
    let https = u.to_ascii_lowercase().starts_with("https://");
    let rest = u
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    if rest.is_empty() {
        return (String::new(), "3000".into(), false);
    }
    if let Some((h, p)) = rest.rsplit_once(':') {
        if p.chars().all(|c| c.is_ascii_digit()) {
            return (h.to_string(), p.to_string(), https);
        }
    }
    (rest.to_string(), if https { "443" } else { "3000" }.into(), https)
}

fn join_server(https: bool, host: &str, port: &str) -> String {
    let scheme = if https { "https" } else { "http" };
    let host = host.trim().trim_end_matches('/');
    let port = port.trim();
    if host.is_empty() {
        return String::new();
    }
    if port.is_empty() || (https && port == "443") || (!https && port == "80") {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}:{port}")
    }
}

fn apply_prefs(app: &mut CoraxApp) {
    let url = join_server(app.https, &app.host, &app.port);
    if url.is_empty() {
        return;
    }
    let _ = save_user_prefs(&url, app.daily_hour, app.daily_minute, app.autostart);
    let _ = app.kick.try_send(());
    app.tab = 0;
}

fn setup_panel(ui: &mut Ui, app: &mut CoraxApp) {
    ui.add_space(24.0);
    ui.label(RichText::new("Установка").size(22.0).color(TEXT).strong());
    ui.add_space(6.0);
    ui.label(
        RichText::new(if load_config().token.is_empty() {
            "В этом файле токена нет. Скачайте ZIP со страницы «Сборка агента» в панели CORAX."
        } else {
            "Токен уже внутри этого EXE и зашифрован. Укажите IP сервера CORAX в вашей сети."
        })
            .size(13.0)
            .color(MUTED),
    );
    ui.add_space(18.0);
    server_fields(ui, app);
    ui.add_space(18.0);
    let go = egui::Button::new(RichText::new("Готово").size(16.0).color(ON_ACCENT).strong())
        .fill(ACCENT)
        .corner_radius(CornerRadius::same(14))
        .min_size(Vec2::new(ui.available_width(), 46.0));
    if ui.add_enabled(!app.host.trim().is_empty(), go).clicked() {
        apply_prefs(app);
    }
}

fn settings_panel(ui: &mut Ui, app: &mut CoraxApp) {
    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            settings_panel_inner(ui, app);
        });
}

fn settings_panel_inner(ui: &mut Ui, app: &mut CoraxApp) {
    ui.add_space(8.0);
    ui.label(RichText::new("Настройки").size(18.0).color(TEXT).strong());
    ui.add_space(12.0);
    server_fields(ui, app);
    ui.add_space(14.0);
    ui.label(RichText::new("Ежедневный отчёт").size(12.0).color(MUTED));
    ui.add_space(4.0);
    ui.horizontal(|ui| {
        ui.label(RichText::new("в").size(12.0).color(MUTED));
        egui::ComboBox::from_id_salt("daily_hour")
            .selected_text(format!("{:02}", app.daily_hour))
            .show_ui(ui, |ui| {
                for h in 0u32..24 {
                    ui.selectable_value(&mut app.daily_hour, h, format!("{h:02}"));
                }
            });
        ui.label(RichText::new(":").size(14.0).color(TEXT));
        egui::ComboBox::from_id_salt("daily_minute")
            .selected_text(format!("{:02}", app.daily_minute))
            .show_ui(ui, |ui| {
                for m in [0u32, 15, 30, 45] {
                    ui.selectable_value(&mut app.daily_minute, m, format!("{m:02}"));
                }
            });
    });
    ui.add_space(6.0);
    ui.label(
        RichText::new("По локальным часам ПК. Если в это время компьютер был выключен — отчёт уйдёт при следующем запуске.")
            .size(11.0)
            .color(MUTED),
    );
    ui.add_space(12.0);
    ui.checkbox(
        &mut app.autostart,
        RichText::new("Запускать вместе с Windows").size(13.0).color(TEXT),
    );
    ui.add_space(8.0);
    ui.label(
        RichText::new("Без автозапуска суточный отчёт не уйдёт, пока пользователь не откроет агент.")
            .size(11.0)
            .color(MUTED),
    );
    ui.add_space(16.0);
    ui.label(RichText::new("Заявки").size(12.0).color(MUTED));
    ui.add_space(6.0);
    ui.label(
        RichText::new("Ярлык на рабочий стол открывает форму /h с IP этого сервера и именем ПК.")
            .size(11.0)
            .color(MUTED),
    );
    ui.add_space(8.0);
    let shortcut_btn = egui::Button::new(
        RichText::new("Создать ярлык «Оставить заявку»")
            .size(13.5)
            .color(ACCENT)
            .strong(),
    )
    .fill(CARD_HI)
    .stroke(Stroke::new(1.2_f32, PEACH))
    .corner_radius(CornerRadius::same(14))
    .min_size(Vec2::new(ui.available_width(), 42.0));
    if ui.add(shortcut_btn).clicked() {
        let url = join_server(app.https, &app.host, &app.port);
        app.shortcut_note = match create_helpdesk_shortcut(&url) {
            Ok(msg) => format!("готово · {msg}"),
            Err(e) => format!("не вышло · {e}"),
        };
    }
    if !app.shortcut_note.is_empty() {
        ui.add_space(6.0);
        ui.label(RichText::new(&app.shortcut_note).size(11.0).color(if app.shortcut_note.starts_with("готово") { OK } else { BAD }));
    }
    ui.add_space(16.0);
    if ui
        .add(
            egui::Button::new(RichText::new("Сохранить").size(15.0).color(ON_ACCENT).strong())
                .fill(ACCENT)
                .corner_radius(CornerRadius::same(16))
                .min_size(Vec2::new(ui.available_width(), 44.0)),
        )
        .clicked()
    {
        apply_prefs(app);
    }
}

fn server_fields(ui: &mut Ui, app: &mut CoraxApp) {
    ui.label(RichText::new("Адрес сервера").size(11.0).color(MUTED));
    ui.add(
        egui::TextEdit::singleline(&mut app.host)
            .hint_text("192.168.1.10")
            .desired_width(f32::INFINITY)
            .font(FontId::monospace(14.0)),
    );
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        ui.label(RichText::new("Порт").size(11.0).color(MUTED));
        ui.add(
            egui::TextEdit::singleline(&mut app.port)
                .desired_width(72.0)
                .font(FontId::monospace(14.0)),
        );
        if ui.selectable_label(!app.https, "http").clicked() {
            app.https = false;
            if app.port == "443" {
                app.port = "3000".into();
            }
        }
        if ui.selectable_label(app.https, "https").clicked() {
            app.https = true;
        }
    });
}

pub fn native_options() -> eframe::NativeOptions {
    let icon = eframe::icon_data::from_png_bytes(include_bytes!("../icons/128x128.png")).ok();
    let mut viewport = egui::ViewportBuilder::default()
        .with_inner_size([420.0, 800.0])
        .with_min_inner_size([400.0, 700.0])
        .with_max_inner_size([480.0, 900.0])
        .with_decorations(false)
        .with_resizable(false)
        .with_title("CORAX")
        .with_active(true);
    if let Some(icon) = icon {
        viewport = viewport.with_icon(icon);
    }
    eframe::NativeOptions {
        viewport,
        centered: true,
        persist_window: false,
        ..Default::default()
    }
}
