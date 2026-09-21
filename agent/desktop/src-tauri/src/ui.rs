use crate::config::{load_config, next_report_label, save_user_prefs};
use crate::shortcut::create_helpdesk_shortcut;
use crate::state::{Flags, RunOutcome, SharedState};
use eframe::egui::{
    self, Color32, CornerRadius, FontId, Frame, Margin, Pos2, Rect, RichText, Sense, Stroke,
    TextureHandle, Ui, Vec2, ViewportCommand,
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

// WinUI / Fluent 2 light
const BG0: Color32 = Color32::from_rgb(243, 243, 243);
const BG1: Color32 = Color32::from_rgb(233, 242, 252);
const CARD: Color32 = Color32::from_rgba_unmultiplied(255, 255, 255, 242);
const CARD_SOLID: Color32 = Color32::WHITE;
const LINE: Color32 = Color32::from_rgba_unmultiplied(0, 0, 0, 22);
const TEXT: Color32 = Color32::from_rgb(27, 27, 27);
const MUTED: Color32 = Color32::from_rgb(96, 94, 92);
const ACCENT: Color32 = Color32::from_rgb(0, 95, 184);
const ACCENT_SOFT: Color32 = Color32::from_rgb(96, 205, 255);
const OK: Color32 = Color32::from_rgb(15, 123, 15);
const BAD: Color32 = Color32::from_rgb(196, 43, 28);
const WARN: Color32 = Color32::from_rgb(157, 93, 0);
const ON_ACCENT: Color32 = Color32::WHITE;

const COLLECT_PHASES: [&str; 7] = [
    "Читаю систему",
    "Процессор и память",
    "Диски и тома",
    "Сеть",
    "Программы",
    "Мониторы и периферия",
    "Отправляю отчёт",
];

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

fn ease_out(t: f32) -> f32 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}

fn lerp_color(a: Color32, b: Color32, t: f32) -> Color32 {
    let t = t.clamp(0.0, 1.0);
    Color32::from_rgba_unmultiplied(
        (a.r() as f32 + (b.r() as f32 - a.r() as f32) * t) as u8,
        (a.g() as f32 + (b.g() as f32 - a.g() as f32) * t) as u8,
        (a.b() as f32 + (b.b() as f32 - a.b() as f32) * t) as u8,
        (a.a() as f32 + (b.a() as f32 - a.a() as f32) * t) as u8,
    )
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
    painted_tab: u8,
    enter_at: f64,
    collect_at: f64,
    was_collecting: bool,
    reveal_at: f64,
    toggle_t: f32,
    host: String,
    port: String,
    https: bool,
    daily_hour: u32,
    daily_minute: u32,
    autostart: bool,
    has_token: bool,
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
        let need_setup = cfg.server_url.is_empty();
        Self {
            state,
            kick,
            flags,
            tray,
            idle_icon,
            busy_icon,
            logo: None,
            last_outcome: None,
            tab: if need_setup { 2 } else { 0 },
            painted_tab: if need_setup { 2 } else { 0 },
            enter_at: 0.0,
            collect_at: 0.0,
            was_collecting: false,
            reveal_at: 0.0,
            toggle_t: if cfg.autostart { 1.0 } else { 0.0 },
            host,
            port,
            https,
            daily_hour: cfg.daily_hour,
            daily_minute: cfg.daily_minute,
            autostart: cfg.autostart,
            has_token: !cfg.token.is_empty(),
            shortcut_note: String::new(),
        }
    }

    fn sync_tray(&mut self, collecting: bool, outcome: RunOutcome) {
        let Some(tray) = self.tray.as_ref() else { return };
        if collecting {
            let _ = tray.set_icon(Some(self.busy_icon.clone()));
            let _ = tray.set_tooltip(Some("CORAX · спокойно собираю этот ПК"));
            return;
        }
        let _ = tray.set_icon(Some(self.idle_icon.clone()));
        self.last_outcome = Some(outcome);
        let tip = match outcome {
            RunOutcome::Sent => "CORAX · инвентарь на сервере",
            RunOutcome::NeedConfig => "CORAX · укажите сервер",
            RunOutcome::Failed => "CORAX · отчёт не ушёл",
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
        BG0.to_normalized_gamma_f32()
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

        let t = ctx.input(|i| i.time);
        if collecting && !self.was_collecting {
            self.collect_at = t;
        }
        if !collecting && self.was_collecting {
            self.reveal_at = t;
        }
        self.was_collecting = collecting;

        let target_toggle = if self.autostart { 1.0 } else { 0.0 };
        self.toggle_t += (target_toggle - self.toggle_t) * 0.22;
        if (self.toggle_t - target_toggle).abs() > 0.002 {
            ctx.request_repaint();
        }

        if self.tab != self.painted_tab {
            self.painted_tab = self.tab;
            self.enter_at = t;
        }
        let enter = ease_out(((t - self.enter_at) / 0.38) as f32);

        if self.logo.is_none() {
            let img = load_color_image(include_bytes!("../icons/128x128.png"));
            self.logo = Some(ctx.load_texture("raven", img, egui::TextureOptions::LINEAR));
        }

        egui::CentralPanel::default()
            .frame(Frame::NONE.fill(BG0).inner_margin(Margin::same(0)))
            .show(ctx, |ui| {
                paint_mica(ui, t);
                draw_chrome(ui, ctx, &mut self.tab);
                ui.add_space(6.0);
                ui.allocate_ui_with_layout(
                    ui.available_size(),
                    egui::Layout::top_down(egui::Align::Center),
                    |ui| {
                        ui.set_max_width(392.0);
                        ui.set_opacity(0.35 + 0.65 * enter);
                        ui.add_space((1.0 - enter) * 14.0);
                        if self.tab == 2 || (self.host.is_empty() && load_config().server_url.is_empty())
                        {
                            self.tab = 2;
                            setup_panel(ui, self);
                        } else if self.tab == 1 {
                            settings_panel(ui, self);
                        } else {
                            home(ui, self, collecting, &snap, t);
                        }
                    },
                );
            });

        ctx.request_repaint_after(std::time::Duration::from_millis(if collecting {
            16
        } else {
            33
        }));
    }
}

fn apply_theme(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::light();
    visuals.panel_fill = BG0;
    visuals.window_fill = CARD_SOLID;
    visuals.extreme_bg_color = Color32::WHITE;
    visuals.faint_bg_color = BG1;
    visuals.override_text_color = Some(TEXT);
    visuals.hyperlink_color = ACCENT;
    visuals.selection.bg_fill = Color32::from_rgb(209, 232, 255);
    visuals.selection.stroke = Stroke::new(1.0_f32, ACCENT);
    visuals.widgets.noninteractive.bg_fill = CARD_SOLID;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, MUTED);
    visuals.widgets.inactive.bg_fill = Color32::WHITE;
    visuals.widgets.inactive.weak_bg_fill = Color32::WHITE;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, LINE);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT);
    visuals.widgets.hovered.bg_fill = Color32::from_rgb(243, 249, 255);
    visuals.widgets.hovered.weak_bg_fill = Color32::from_rgb(243, 249, 255);
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, ACCENT);
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, TEXT);
    visuals.widgets.active.bg_fill = ACCENT;
    visuals.widgets.active.fg_stroke = Stroke::new(1.0_f32, ON_ACCENT);
    visuals.widgets.open.bg_fill = Color32::WHITE;
    visuals.window_corner_radius = CornerRadius::same(8);
    visuals.widgets.inactive.corner_radius = CornerRadius::same(4);
    visuals.widgets.hovered.corner_radius = CornerRadius::same(4);
    visuals.widgets.active.corner_radius = CornerRadius::same(4);
    visuals.window_shadow = egui::Shadow::NONE;
    visuals.popup_shadow = egui::Shadow::NONE;
    ctx.set_visuals(visuals);
}

fn paint_mica(ui: &mut Ui, t: f64) {
    let rect = ui.max_rect();
    let p = ui.painter();
    p.rect_filled(rect, CornerRadius::ZERO, BG0);
    let a = Pos2::new(
        rect.left() + 70.0 + (t * 0.31).sin() as f32 * 36.0,
        rect.top() + 90.0 + (t * 0.23).cos() as f32 * 22.0,
    );
    let b = Pos2::new(
        rect.right() - 40.0 + (t * 0.19).cos() as f32 * 28.0,
        rect.bottom() - 120.0 + (t * 0.27).sin() as f32 * 30.0,
    );
    let c = Pos2::new(
        rect.center().x + (t * 0.14).sin() as f32 * 50.0,
        rect.center().y - 40.0 + (t * 0.17).cos() as f32 * 18.0,
    );
    p.circle_filled(a, 130.0, Color32::from_rgba_unmultiplied(0, 95, 184, 18));
    p.circle_filled(b, 150.0, Color32::from_rgba_unmultiplied(96, 205, 255, 22));
    p.circle_filled(c, 90.0, Color32::from_rgba_unmultiplied(251, 146, 60, 12));
    let step = 28.0;
    let fade = Color32::from_rgba_unmultiplied(0, 95, 184, 10);
    let mut x = rect.left();
    while x < rect.right() {
        p.line_segment(
            [Pos2::new(x, rect.top()), Pos2::new(x, rect.bottom())],
            Stroke::new(1.0, fade),
        );
        x += step;
    }
    let mut y = rect.top();
    while y < rect.bottom() {
        p.line_segment(
            [Pos2::new(rect.left(), y), Pos2::new(rect.right(), y)],
            Stroke::new(1.0, fade),
        );
        y += step;
    }
}

fn draw_chrome(ui: &mut Ui, ctx: &egui::Context, tab: &mut u8) {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 46.0), Sense::click_and_drag());
    if resp.dragged() {
        ctx.send_viewport_cmd(ViewportCommand::StartDrag);
    }
    ui.painter().text(
        Pos2::new(rect.left() + 18.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        "CORAX",
        FontId::proportional(13.0),
        ACCENT,
    );
    ui.painter().text(
        Pos2::new(rect.left() + 78.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        "Agent",
        FontId::proportional(13.0),
        MUTED,
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
    let r = Rect::from_center_size(c, Vec2::splat(30.0));
    let resp = ui.allocate_rect(r, Sense::click());
    let fill = if resp.hovered() {
        Color32::from_rgba_unmultiplied(0, 0, 0, 16)
    } else {
        Color32::TRANSPARENT
    };
    ui.painter().rect_filled(r, CornerRadius::same(4), fill);
    ui.painter().text(
        c,
        egui::Align2::CENTER_CENTER,
        glyph,
        FontId::proportional(16.0),
        if resp.hovered() { TEXT } else { MUTED },
    );
    resp
}

fn home(ui: &mut Ui, app: &mut CoraxApp, collecting: bool, snap: &crate::state::Snapshot, t: f64) {
    hero(ui, app.logo.as_ref(), collecting, t, app.collect_at);
    ui.add_space(10.0);
    status_card(ui, collecting, snap, t, app.collect_at);
    ui.add_space(10.0);
    let reveal = ease_out(((t - app.reveal_at) / 0.55) as f32);
    specs_card(ui, snap, if collecting { 0.35 } else { 0.55 + 0.45 * reveal });
    ui.add_space(14.0);
    collect_button(ui, collecting, &app.kick);
    ui.add_space(12.0);
    footer(ui, snap, collecting);
}

fn hero(ui: &mut Ui, logo: Option<&TextureHandle>, collecting: bool, t: f64, collect_at: f64) {
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 128.0), Sense::hover());
    let c = rect.center();
    let breath = ((t * 1.15).sin() as f32 + 1.0) * 0.5;
    if collecting {
        let elapsed = (t - collect_at).max(0.0);
        progress_ring(ui, c, 54.0 + breath * 2.0, elapsed, ACCENT);
        progress_ring(ui, c, 42.0, elapsed * 1.35 + 1.1, ACCENT_SOFT);
        let pulse = ((elapsed * 3.2).sin() as f32 + 1.0) * 0.5;
        ui.painter().circle_filled(
            c,
            34.0 + pulse * 3.0,
            Color32::from_rgba_unmultiplied(0, 95, 184, 18 + (pulse * 20.0) as u8),
        );
    } else {
        ui.painter().circle_filled(
            c,
            56.0 + breath * 4.0,
            Color32::from_rgba_unmultiplied(0, 95, 184, 10 + (breath * 10.0) as u8),
        );
        ui.painter().circle_stroke(
            c,
            48.0,
            Stroke::new(1.1_f32, Color32::from_rgba_unmultiplied(0, 95, 184, 40)),
        );
    }
    if let Some(tex) = logo {
        let logo_r = Rect::from_center_size(c, Vec2::splat(68.0));
        egui::Image::new(tex)
            .corner_radius(CornerRadius::same(12))
            .paint_at(ui, logo_r);
    }
}

fn progress_ring(ui: &mut Ui, center: Pos2, radius: f32, t: f64, color: Color32) {
    let start = t * 2.35;
    let sweep = 4.2 + 1.1 * (t * 1.6).sin();
    let n = 42;
    let painter = ui.painter();
    for i in 0..n {
        let k = i as f64 / n as f64;
        let a0 = start + sweep * k;
        let a1 = start + sweep * ((i + 1) as f64 / n as f64);
        let fade = (k as f32).powf(0.65);
        let p0 = center + Vec2::new((a0 as f32).cos(), (a0 as f32).sin()) * radius;
        let p1 = center + Vec2::new((a1 as f32).cos(), (a1 as f32).sin()) * radius;
        painter.line_segment(
            [p0, p1],
            Stroke::new(
                3.2,
                Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), (18.0 + fade * 200.0) as u8),
            ),
        );
    }
}

fn collect_phase(elapsed: f64) -> &'static str {
    let i = ((elapsed / 0.72) as usize).min(COLLECT_PHASES.len() - 1);
    COLLECT_PHASES[i]
}

fn status_card(ui: &mut Ui, collecting: bool, snap: &crate::state::Snapshot, t: f64, collect_at: f64) {
    let (title, sub, color) = if collecting {
        (
            collect_phase(t - collect_at).to_string(),
            "Собираю этот компьютер — можно свернуть в трей".to_string(),
            ACCENT,
        )
    } else {
        match snap.outcome {
            RunOutcome::Sent => (
                "Инвентарь на сервере".into(),
                if snap.at.is_empty() {
                    "Отчёт ушёл спокойно".into()
                } else {
                    format!("Последний отчёт  {}", snap.at)
                },
                OK,
            ),
            RunOutcome::NeedConfig => (
                "Нужен адрес сервера".into(),
                if snap.detail.is_empty() {
                    "Токен уже в agent.json рядом с программой".into()
                } else {
                    snap.detail.clone()
                },
                WARN,
            ),
            RunOutcome::Failed => (
                "Отчёт не ушёл".into(),
                if snap.detail.is_empty() {
                    "Проверьте сеть и токен".into()
                } else {
                    snap.detail.clone()
                },
                BAD,
            ),
        }
    };
    fluent_card(ui, |ui| {
        ui.horizontal(|ui| {
            let (dot, _) = ui.allocate_exact_size(Vec2::splat(10.0), Sense::hover());
            let pulse = if collecting {
                ((t * 4.0).sin() as f32 + 1.0) * 0.5
            } else {
                1.0
            };
            ui.painter().circle_filled(
                dot.center(),
                4.0 + pulse,
                Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), (80.0 + pulse * 140.0) as u8),
            );
            ui.painter().circle_filled(dot.center(), 3.2, color);
            ui.add_space(10.0);
            ui.vertical(|ui| {
                ui.label(RichText::new(title).size(17.0).color(TEXT).strong());
                ui.add_space(2.0);
                ui.label(RichText::new(sub).size(12.0).color(MUTED));
            });
        });
    });
}

fn specs_card(ui: &mut Ui, snap: &crate::state::Snapshot, opacity: f32) {
    ui.scope(|ui| {
        ui.set_opacity(opacity.clamp(0.2, 1.0));
        fluent_card(ui, |ui| {
            ui.label(
                RichText::new(snap.hostname.to_uppercase())
                    .size(12.0)
                    .color(ACCENT)
                    .strong(),
            );
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
    });
}

fn spec(ui: &mut Ui, k: &str, v: &str) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(k).size(12.0).color(MUTED));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(RichText::new(truncate(v, 34)).size(12.5).color(TEXT));
        });
    });
    ui.add_space(4.0);
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

fn fluent_card(ui: &mut Ui, add: impl FnOnce(&mut Ui)) {
    Frame::new()
        .fill(CARD)
        .stroke(Stroke::new(1.0_f32, LINE))
        .corner_radius(CornerRadius::same(8))
        .inner_margin(Margin::symmetric(16, 14))
        .shadow(egui::Shadow {
            offset: [0, 1],
            blur: 8,
            spread: 0,
            color: Color32::from_rgba_unmultiplied(0, 0, 0, 18),
        })
        .show(ui, add);
}

fn fluent_button(ui: &mut Ui, label: &str, enabled: bool) -> egui::Response {
    let fill = if enabled { ACCENT } else { Color32::from_rgb(186, 212, 239) };
    let btn = egui::Button::new(RichText::new(label).size(14.5).color(ON_ACCENT).strong())
        .fill(fill)
        .corner_radius(CornerRadius::same(6))
        .min_size(Vec2::new(ui.available_width(), 40.0));
    let resp = ui.add_enabled(enabled, btn);
    if resp.hovered() && enabled {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

fn collect_button(ui: &mut Ui, collecting: bool, kick: &SyncSender<()>) {
    let label = if collecting {
        "Собираю…"
    } else {
        "Собрать сейчас"
    };
    if fluent_button(ui, label, !collecting).clicked() {
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
    ui.add_space(18.0);
    ui.label(RichText::new("Установка").size(22.0).color(TEXT).strong());
    ui.add_space(6.0);
    ui.label(
        RichText::new(if app.has_token {
            "Токен уже лежит рядом в agent.json — EXE не менялся. Укажите IP сервера, если его нет в сборке."
        } else {
            "В этой папке нет agent.json с токеном. Скачайте ZIP со страницы «Сборка агента»."
        })
        .size(13.0)
        .color(MUTED),
    );
    ui.add_space(16.0);
    server_fields(ui, app);
    ui.add_space(16.0);
    if fluent_button(ui, "Готово — собрать этот ПК", !app.host.trim().is_empty()).clicked() {
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
    ui.add_space(6.0);
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
        RichText::new("По часам этого ПК. Если компьютер был выключен — отчёт уйдёт при следующем запуске.")
            .size(11.0)
            .color(MUTED),
    );
    ui.add_space(14.0);
    fluent_toggle(ui, app);
    ui.add_space(6.0);
    ui.label(
        RichText::new("Без автозапуска суточный отчёт не уйдёт, пока агент не откроют.")
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
            .size(13.0)
            .color(ACCENT)
            .strong(),
    )
    .fill(Color32::from_rgb(243, 249, 255))
    .stroke(Stroke::new(1.0_f32, Color32::from_rgba_unmultiplied(0, 95, 184, 50)))
    .corner_radius(CornerRadius::same(6))
    .min_size(Vec2::new(ui.available_width(), 38.0));
    if ui.add(shortcut_btn).clicked() {
        let url = join_server(app.https, &app.host, &app.port);
        app.shortcut_note = match create_helpdesk_shortcut(&url) {
            Ok(msg) => format!("готово · {msg}"),
            Err(e) => format!("не вышло · {e}"),
        };
    }
    if !app.shortcut_note.is_empty() {
        ui.add_space(6.0);
        ui.label(RichText::new(&app.shortcut_note).size(11.0).color(
            if app.shortcut_note.starts_with("готово") {
                OK
            } else {
                BAD
            },
        ));
    }
    ui.add_space(16.0);
    if fluent_button(ui, "Сохранить", true).clicked() {
        apply_prefs(app);
    }
}

fn fluent_toggle(ui: &mut Ui, app: &mut CoraxApp) {
    ui.horizontal(|ui| {
        let (rect, resp) = ui.allocate_exact_size(Vec2::new(40.0, 20.0), Sense::click());
        if resp.clicked() {
            app.autostart = !app.autostart;
        }
        let t = app.toggle_t;
        let track = lerp_color(
            Color32::from_rgb(200, 198, 196),
            ACCENT,
            t,
        );
        ui.painter()
            .rect_filled(rect, CornerRadius::same(10), track);
        let knob_x = rect.left() + 10.0 + t * 20.0;
        ui.painter().circle_filled(
            Pos2::new(knob_x, rect.center().y),
            8.0,
            Color32::WHITE,
        );
        ui.add_space(10.0);
        ui.label(RichText::new("Запускать вместе с Windows").size(13.0).color(TEXT));
    });
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
        .with_inner_size([428.0, 720.0])
        .with_min_inner_size([400.0, 640.0])
        .with_max_inner_size([480.0, 860.0])
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
