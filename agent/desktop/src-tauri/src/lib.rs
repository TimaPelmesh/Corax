mod collect;
mod config;
mod crypto;
mod shortcut;
mod state;
mod ui;

use collect::{collect_inventory, post_inventory};
use config::{load_config, mark_ok_today, should_send_daily, wait_until_next_daily, write_last_run};
use state::{Flags, RunOutcome, Shared, SharedState, Snapshot};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use ui::{native_options, CoraxApp};

fn now_str() -> String {
    chrono::Local::now().format("%d.%m.%Y  %H:%M").to_string()
}

fn dash(s: Option<String>) -> String {
    s.map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "—".into())
}

fn snapshot_from_report(
    outcome: RunOutcome,
    report: &collect::InventoryReport,
    detail: String,
    server: String,
) -> Snapshot {
    let ram = report
        .ram_gb
        .map(|g| {
            if let Some(p) = report.memory_used_percent {
                format!("{g:.0} ГБ · занято {p}%")
            } else {
                format!("{g:.0} ГБ")
            }
        })
        .unwrap_or_else(|| "—".into());
    let model = match (&report.manufacturer, &report.model) {
        (Some(a), Some(b)) => format!("{a} {b}"),
        (None, Some(b)) => b.clone(),
        (Some(a), None) => a.clone(),
        _ => "—".into(),
    };
    Snapshot {
        outcome,
        hostname: report.hostname.clone(),
        cpu: dash(report.cpu.clone()),
        ram,
        os: dash(report.os_name.clone()),
        gpu: dash(report.gpu_name.clone()),
        model,
        disks: format!("{}", report.disks.len()),
        software: format!("{}", report.software.len()),
        peripherals: format!("{}", report.peripherals.len()),
        monitors: format!(
            "{}",
            report
                .peripherals
                .iter()
                .filter(|p| p.get("kind").and_then(|x| x.as_str()) == Some("monitor"))
                .count()
        ),
        audio: format!(
            "{}",
            report
                .peripherals
                .iter()
                .filter(|p| p.get("kind").and_then(|x| x.as_str()) == Some("audio"))
                .count()
        ),
        detail,
        server,
        at: now_str(),
    }
}

fn run_once() -> Snapshot {
    let cfg = load_config();
    let server = cfg.server_url.clone();
    if cfg.server_url.is_empty() || cfg.token.is_empty() {
        let detail = if cfg.server_url.is_empty() && cfg.token.is_empty() {
            "укажите IP сервера. Токен вшивается в EXE при скачивании с панели"
        } else if cfg.server_url.is_empty() {
            "укажите IP сервера CORAX"
        } else {
            "в этом EXE нет токена — скачайте сборку со страницы «Сборка агента», не шаблон из папки"
        };
        write_last_run(false, detail);
        let mut s = Snapshot::default();
        s.outcome = RunOutcome::NeedConfig;
        s.server = server;
        s.detail = detail.into();
        s.at = now_str();
        return s;
    }
    match collect_inventory() {
        Ok(report) => match post_inventory(&cfg.server_url, &cfg.token, &report) {
            Ok(_) => {
                write_last_run(true, &format!("sent {}", report.hostname));
                snapshot_from_report(RunOutcome::Sent, &report, format!("sent {}", report.hostname), server)
            }
            Err(e) => {
                write_last_run(false, &e);
                snapshot_from_report(RunOutcome::Failed, &report, e, server)
            }
        },
        Err(e) => {
            write_last_run(false, &e);
            let mut s = Snapshot::default();
            s.outcome = RunOutcome::Failed;
            s.server = server;
            s.detail = e;
            s.at = now_str();
            s
        }
    }
}

pub fn run() {
    let state: SharedState = Arc::new(Mutex::new(Shared {
        collecting: false,
        last: Snapshot::default(),
    }));
    let flags = Flags::new();
    let (kick_tx, kick_rx) = mpsc::sync_channel::<()>(1);

    {
        let state = Arc::clone(&state);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(500));
            let mut kicked = false;
            loop {
                let cfg = load_config();
                let due = kicked || should_send_daily(&cfg);
                if due {
                    if let Ok(mut g) = state.lock() {
                        g.collecting = true;
                    }
                    let snap = run_once();
                    let outcome = snap.outcome;
                    if outcome == RunOutcome::Sent {
                        mark_ok_today();
                    }
                    if let Ok(mut g) = state.lock() {
                        g.collecting = false;
                        g.last = snap;
                    }
                    kicked = false;
                    let wait = match outcome {
                        RunOutcome::NeedConfig => Duration::from_secs(20),
                        RunOutcome::Failed => Duration::from_secs(15 * 60),
                        RunOutcome::Sent => wait_until_next_daily(&load_config()),
                    };
                    match kick_rx.recv_timeout(wait) {
                        Ok(()) => kicked = true,
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                    continue;
                }
                match kick_rx.recv_timeout(wait_until_next_daily(&cfg)) {
                    Ok(()) => kicked = true,
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        });
    }

    let ui_state = Arc::clone(&state);
    let ui_kick = kick_tx;
    let ui_flags = flags;
    let _ = eframe::run_native(
        "CORAX",
        native_options(),
        Box::new(move |cc| Ok(Box::new(CoraxApp::new(cc, ui_state, ui_kick, ui_flags)))),
    );
}
