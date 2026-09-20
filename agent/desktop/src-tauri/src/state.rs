use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    Sent,
    NeedConfig,
    Failed,
}

#[derive(Clone)]
pub struct Snapshot {
    pub outcome: RunOutcome,
    pub hostname: String,
    pub cpu: String,
    pub ram: String,
    pub os: String,
    pub gpu: String,
    pub model: String,
    pub disks: String,
    pub software: String,
    pub peripherals: String,
    pub monitors: String,
    pub audio: String,
    pub detail: String,
    pub server: String,
    pub at: String,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            outcome: RunOutcome::NeedConfig,
            hostname: std::env::var("COMPUTERNAME").unwrap_or_else(|_| "ПК".into()),
            cpu: "—".into(),
            ram: "—".into(),
            os: "—".into(),
            gpu: "—".into(),
            model: "—".into(),
            disks: "—".into(),
            software: "—".into(),
            peripherals: "—".into(),
            monitors: "—".into(),
            audio: "—".into(),
            detail: String::new(),
            server: String::new(),
            at: String::new(),
        }
    }
}

pub struct Shared {
    pub collecting: bool,
    pub last: Snapshot,
}

pub type SharedState = Arc<Mutex<Shared>>;

#[derive(Clone)]
pub struct Flags {
    pub show: Arc<AtomicBool>,
    pub quit: Arc<AtomicBool>,
    pub settings: Arc<AtomicBool>,
}

impl Flags {
    pub fn new() -> Self {
        Self {
            show: Arc::new(AtomicBool::new(false)),
            quit: Arc::new(AtomicBool::new(false)),
            settings: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn request_show(&self) {
        self.show.store(true, Ordering::SeqCst);
    }

    pub fn request_settings(&self) {
        self.settings.store(true, Ordering::SeqCst);
        self.request_show();
    }

    pub fn request_quit(&self) {
        self.quit.store(true, Ordering::SeqCst);
    }
}
