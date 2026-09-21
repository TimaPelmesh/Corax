use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDate, NaiveTime, TimeDelta, TimeZone};
use winreg::enums::*;
use winreg::RegKey;

use crate::crypto::{token_from_current_exe, unseal_token};

#[derive(Clone, Debug)]
pub struct AgentConfig {
    pub server_url: String,
    pub token: String,
    pub daily_hour: u32,
    pub daily_minute: u32,
    pub autostart: bool,
    pub last_ok_date: String,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            token: String::new(),
            daily_hour: 9,
            daily_minute: 0,
            autostart: true,
            last_ok_date: String::new(),
        }
    }
}

pub fn program_data_dir() -> PathBuf {
    let pd = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into());
    PathBuf::from(pd).join("CORAX").join("agent")
}

pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|x| x.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn looks_like_agent_token(s: &str) -> bool {
    let s = s.trim();
    let Some((id, secret)) = s.split_once('.') else {
        return false;
    };
    !id.is_empty() && !secret.is_empty() && !id.contains(char::is_whitespace) && !secret.contains(char::is_whitespace)
}

fn parse_hhmm(raw: &str) -> Option<(u32, u32)> {
    let s = raw.trim();
    let (h, m) = s.split_once(':')?;
    let hour: u32 = h.parse().ok()?;
    let minute: u32 = m.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((hour, minute))
}

fn parse_bat_env(text: &str) -> (String, String) {
    let mut server = String::new();
    let mut token = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("set ").or_else(|| line.strip_prefix("SET ")) {
            let rest = rest.trim().trim_matches('"');
            if let Some((k, v)) = rest.split_once('=') {
                let key = k.trim().trim_matches('"');
                let val = v.trim().trim_matches('"').to_string();
                if key.eq_ignore_ascii_case("INVENTORY_SERVER") {
                    server = val;
                } else if key.eq_ignore_ascii_case("AGENT_TOKEN") {
                    token = val;
                }
            }
        }
    }
    (server, token)
}

fn token_from_json(v: &serde_json::Value) -> String {
    if let Some(enc) = v.get("token_enc") {
        if let (Some(wrap), Some(nonce), Some(ct)) = (
            enc.get("wrap").and_then(|x| x.as_str()),
            enc.get("nonce").and_then(|x| x.as_str()),
            enc.get("ct").and_then(|x| x.as_str()),
        ) {
            if let Ok(t) = unseal_token(wrap, nonce, ct) {
                if looks_like_agent_token(&t) {
                    return t;
                }
            }
        }
    }
    for key in ["token", "AGENT_TOKEN"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            let s = s.trim().to_string();
            if looks_like_agent_token(&s) {
                return s;
            }
        }
    }
    String::new()
}

struct JsonBits {
    server: String,
    token: String,
    daily: Option<(u32, u32)>,
    autostart: Option<bool>,
    last_ok: Option<String>,
}

fn read_json_file(path: &Path) -> JsonBits {
    let empty = JsonBits {
        server: String::new(),
        token: String::new(),
        daily: None,
        autostart: None,
        last_ok: None,
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return empty;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return empty;
    };
    let server = v
        .get("server_url")
        .or_else(|| v.get("INVENTORY_SERVER"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let daily = v.get("daily_at").and_then(|x| x.as_str()).and_then(parse_hhmm);
    JsonBits {
        token: token_from_json(&v),
        daily,
        autostart: v.get("autostart").and_then(|x| x.as_bool()),
        last_ok: v
            .get("last_ok_date")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        server,
    }
}

pub fn load_config() -> AgentConfig {
    let mut cfg = AgentConfig::default();
    let env_server = std::env::var("INVENTORY_SERVER")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty());
    if let Some(ref s) = env_server {
        cfg.server_url = s.clone();
    }

    ensure_sidecar_copies();

    let bundle = [
        exe_dir().join("agent.json"),
        program_data_dir().join("agent.json"),
    ];
    let prefs = [
        exe_dir().join("desktop.json"),
        program_data_dir().join("desktop.json"),
    ];

    for path in bundle {
        apply_bundle(&mut cfg, &read_json_file(&path));
    }
    for path in prefs {
        apply_prefs_file(&mut cfg, &read_json_file(&path));
    }
    if let Some(s) = env_server {
        cfg.server_url = s;
    }

    // Legacy: older panel ZIPs stamped the sealed token into the PE. New packs never do that.
    if cfg.token.is_empty() {
        if let Some(t) = token_from_current_exe() {
            if looks_like_agent_token(&t) {
                cfg.token = t;
            }
        }
    }
    cfg
}

fn apply_bundle(cfg: &mut AgentConfig, bits: &JsonBits) {
    if cfg.token.is_empty() && looks_like_agent_token(&bits.token) {
        cfg.token = bits.token.clone();
    }
    if cfg.server_url.is_empty() {
        cfg.server_url = bits.server.trim().trim_end_matches('/').to_string();
    }
    if let Some((h, m)) = bits.daily {
        cfg.daily_hour = h;
        cfg.daily_minute = m;
    }
    if let Some(a) = bits.autostart {
        cfg.autostart = a;
    }
    if cfg.last_ok_date.is_empty() {
        if let Some(d) = bits.last_ok.clone() {
            cfg.last_ok_date = d;
        }
    }
}

fn apply_prefs_file(cfg: &mut AgentConfig, bits: &JsonBits) {
    let server = bits.server.trim().trim_end_matches('/');
    if !server.is_empty() {
        cfg.server_url = server.to_string();
    }
    if let Some((h, m)) = bits.daily {
        cfg.daily_hour = h;
        cfg.daily_minute = m;
    }
    if let Some(a) = bits.autostart {
        cfg.autostart = a;
    }
    if let Some(d) = bits.last_ok.clone() {
        cfg.last_ok_date = d;
    }
}

fn ensure_sidecar_copies() {
    let src = exe_dir().join("agent.json");
    if !src.is_file() {
        return;
    }
    let dest_dir = program_data_dir();
    let _ = fs::create_dir_all(&dest_dir);
    let dst = dest_dir.join("agent.json");
    if !dst.is_file() {
        let _ = fs::copy(&src, &dst);
    }
}

fn prefs_path() -> PathBuf {
    program_data_dir().join("desktop.json")
}

pub fn save_user_prefs(
    server_url: &str,
    daily_hour: u32,
    daily_minute: u32,
    autostart: bool,
) -> Result<(), String> {
    let hour = daily_hour.min(23);
    let minute = daily_minute.min(59);
    let last = load_config().last_ok_date;
    let v = serde_json::json!({
        "server_url": server_url.trim().trim_end_matches('/'),
        "daily_at": format!("{hour:02}:{minute:02}"),
        "autostart": autostart,
        "last_ok_date": last,
    });
    let raw = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    for dir in [exe_dir(), program_data_dir()] {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join("desktop.json"), &raw);
    }
    let _ = set_autostart(autostart);
    Ok(())
}

pub fn mark_ok_today() {
    let cfg = load_config();
    let last_ok_date = Local::now().format("%Y-%m-%d").to_string();
    let v = serde_json::json!({
        "server_url": cfg.server_url,
        "daily_at": format!("{:02}:{:02}", cfg.daily_hour, cfg.daily_minute),
        "autostart": cfg.autostart,
        "last_ok_date": last_ok_date,
    });
    if let Ok(raw) = serde_json::to_string_pretty(&v) {
        let _ = fs::create_dir_all(program_data_dir());
        let _ = fs::write(prefs_path(), &raw);
        let _ = fs::write(exe_dir().join("desktop.json"), &raw);
    }
}

fn local_at(date: NaiveDate, hour: u32, minute: u32) -> chrono::DateTime<Local> {
    let t = NaiveTime::from_hms_opt(hour.min(23), minute.min(59), 0)
        .unwrap_or_else(|| NaiveTime::from_hms_opt(9, 0, 0).unwrap());
    let ndt = date.and_time(t);
    Local
        .from_local_datetime(&ndt)
        .earliest()
        .unwrap_or_else(|| Local::now())
}

pub fn next_daily_at(cfg: &AgentConfig) -> chrono::DateTime<Local> {
    let now = Local::now();
    let today_s = now.format("%Y-%m-%d").to_string();
    let today = local_at(now.date_naive(), cfg.daily_hour, cfg.daily_minute);
    if cfg.last_ok_date != today_s && today > now {
        today
    } else {
        local_at(
            now.date_naive() + TimeDelta::days(1),
            cfg.daily_hour,
            cfg.daily_minute,
        )
    }
}

pub fn should_send_daily(cfg: &AgentConfig) -> bool {
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    if cfg.last_ok_date == today {
        return false;
    }
    if cfg.last_ok_date.is_empty() {
        return true;
    }
    now >= local_at(now.date_naive(), cfg.daily_hour, cfg.daily_minute)
}

pub fn wait_until_next_daily(cfg: &AgentConfig) -> std::time::Duration {
    let now = Local::now();
    let next = next_daily_at(cfg);
    let delta = next - now;
    delta
        .to_std()
        .unwrap_or(std::time::Duration::from_secs(60))
        .max(std::time::Duration::from_secs(1))
        .min(std::time::Duration::from_secs(60))
}

pub fn next_report_label(cfg: &AgentConfig) -> String {
    next_daily_at(cfg).format("%d.%m.%Y  %H:%M").to_string()
}

pub fn set_autostart(enabled: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if enabled {
        let quoted = format!("\"{}\"", exe.display());
        key.set_value("CORAX Agent", &quoted)
            .map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value("CORAX Agent");
    }
    Ok(())
}

pub fn write_last_run(ok: bool, detail: &str) {
    let line = format!(
        "CORAX agent\nstatus:  {}\ntime:    {}\nhost:    {}\nserver:  {}\ndetail:  {}\n",
        if ok { "OK" } else { "FAILED" },
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        std::env::var("COMPUTERNAME").unwrap_or_default(),
        load_config().server_url,
        detail
    );
    for dir in [exe_dir(), program_data_dir()] {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join("corax-last-run.txt"), &line);
    }
}
