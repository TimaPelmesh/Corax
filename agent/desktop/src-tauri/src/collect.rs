#![allow(non_snake_case, non_camel_case_types)]

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};
use wmi::Variant;

#[derive(serde::Serialize, Default)]
pub struct InventoryReport {
    pub hostname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mac_primary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ram_gb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_used_percent: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motherboard_manufacturer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motherboard_product: Option<String>,
    pub disks: Vec<Value>,
    pub software: Vec<Value>,
    pub peripherals: Vec<Value>,
    pub printers: Vec<Value>,
    pub extended: Value,
}

fn nz(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn env_host() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown-host".into())
}

#[derive(Deserialize, Default)]
struct Win32_ComputerSystem {
    Name: Option<String>,
    Manufacturer: Option<String>,
    Model: Option<String>,
    TotalPhysicalMemory: Option<u64>,
}

#[derive(Deserialize, Default)]
struct Win32_BIOS {
    SerialNumber: Option<String>,
}

#[derive(Deserialize, Default)]
struct Win32_OperatingSystem {
    Caption: Option<String>,
    Version: Option<String>,
    FreePhysicalMemory: Option<u64>,
    TotalVisibleMemorySize: Option<u64>,
}

#[derive(Deserialize, Default)]
struct Win32_Processor {
    Name: Option<String>,
}

#[derive(Deserialize, Default)]
struct Win32_VideoController {
    Name: Option<String>,
}

#[derive(Deserialize, Default)]
struct Win32_BaseBoard {
    Manufacturer: Option<String>,
    Product: Option<String>,
}

#[derive(Deserialize, Default)]
struct Win32_LogicalDisk {
    DeviceID: Option<String>,
    Size: Option<u64>,
    FreeSpace: Option<u64>,
    VolumeName: Option<String>,
    DriveType: Option<u32>,
}

#[derive(Deserialize, Default)]
struct Win32_NetworkAdapterConfiguration {
    IPEnabled: Option<bool>,
    MACAddress: Option<String>,
    IPAddress: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
struct Win32_Keyboard {
    Name: Option<String>,
    Description: Option<String>,
}

#[derive(Deserialize, Default)]
struct Win32_PointingDevice {
    Name: Option<String>,
    Description: Option<String>,
}

#[derive(Deserialize, Default)]
struct Win32_DesktopMonitor {
    Name: Option<String>,
}

#[derive(Deserialize, Default)]
struct Win32_PnPEntity {
    Name: Option<String>,
    Caption: Option<String>,
    Description: Option<String>,
    PNPClass: Option<String>,
    Class: Option<String>,
    ClassGuid: Option<String>,
    ConfigManagerErrorCode: Option<u32>,
}

#[derive(Deserialize, Default)]
struct Win32_SoundDevice {
    Name: Option<String>,
    ProductName: Option<String>,
}

#[derive(Deserialize, Default)]
struct Win32_Printer {
    Name: Option<String>,
    DriverName: Option<String>,
    PortName: Option<String>,
    Shared: Option<bool>,
    Default: Option<bool>,
    Network: Option<bool>,
    PrinterStatus: Option<u32>,
    WorkOffline: Option<bool>,
}

pub fn collect_inventory() -> Result<InventoryReport, String> {
    let com = wmi::COMLibrary::new().map_err(|e| e.to_string())?;
    let wmi = wmi::WMIConnection::new(com).map_err(|e| e.to_string())?;

    let mut report = InventoryReport {
        hostname: env_host(),
        peripherals: vec![],
        printers: vec![],
        software: collect_software(800),
        disks: vec![],
        extended: json!({}),
        ..Default::default()
    };

    if let Ok(rows) = wmi.query::<Win32_ComputerSystem>() {
        if let Some(row) = rows.into_iter().next() {
            if let Some(n) = nz(row.Name) {
                report.hostname = n;
            }
            report.manufacturer = nz(row.Manufacturer);
            report.model = nz(row.Model);
            if let Some(bytes) = row.TotalPhysicalMemory {
                report.ram_gb = Some(((bytes as f64) / 1024.0 / 1024.0 / 1024.0 * 10.0).round() / 10.0);
            }
        }
    }

    if let Ok(rows) = wmi.query::<Win32_BIOS>() {
        if let Some(row) = rows.into_iter().next() {
            report.serial_number = nz(row.SerialNumber).filter(|s| {
                let u = s.to_uppercase();
                !matches!(
                    u.as_str(),
                    "TO BE FILLED BY O.E.M." | "NONE" | "DEFAULT STRING" | "SYSTEM SERIAL NUMBER"
                )
            });
        }
    }

    if let Ok(rows) = wmi.query::<Win32_OperatingSystem>() {
        if let Some(row) = rows.into_iter().next() {
            report.os_name = nz(row.Caption);
            report.os_version = nz(row.Version);
            if let (Some(free), Some(total)) = (row.FreePhysicalMemory, row.TotalVisibleMemorySize) {
                if total > 0 {
                    let used = ((total.saturating_sub(free)) as f64 / total as f64 * 100.0).round() as i32;
                    report.memory_used_percent = Some(used.clamp(0, 100));
                }
            }
        }
    }

    if let Ok(rows) = wmi.query::<Win32_Processor>() {
        report.cpu = rows.into_iter().next().and_then(|r| nz(r.Name));
    }
    if let Ok(rows) = wmi.query::<Win32_VideoController>() {
        report.gpu_name = rows.into_iter().find_map(|r| nz(r.Name));
    }
    if let Ok(rows) = wmi.query::<Win32_BaseBoard>() {
        if let Some(row) = rows.into_iter().next() {
            report.motherboard_manufacturer = nz(row.Manufacturer);
            report.motherboard_product = nz(row.Product);
        }
    }

    if let Ok(rows) = wmi.query::<Win32_LogicalDisk>() {
        for row in rows {
            if row.DriveType != Some(3) {
                continue;
            }
            let Some(mount) = nz(row.DeviceID) else { continue };
            let total = row.Size.unwrap_or(0) as f64 / 1_073_741_824.0;
            let free = row.FreeSpace.unwrap_or(0) as f64 / 1_073_741_824.0;
            let used_percent = if total > 0.1 {
                Some((((total - free) / total) * 100.0).round() as i32)
            } else {
                None
            };
            report.disks.push(json!({
                "mount": mount,
                "label": nz(row.VolumeName),
                "total_gb": (total * 10.0).round() / 10.0,
                "free_gb": (free * 10.0).round() / 10.0,
                "used_percent": used_percent,
            }));
        }
    }

    let mut adapters = Vec::new();
    if let Ok(rows) = wmi.query::<Win32_NetworkAdapterConfiguration>() {
        for row in rows {
            if row.IPEnabled != Some(true) {
                continue;
            }
            let mac = nz(row.MACAddress).map(|m| m.replace('-', ":").to_uppercase());
            let ipv4: Vec<String> = row
                .IPAddress
                .unwrap_or_default()
                .into_iter()
                .filter(|ip| ip.contains('.') && !ip.starts_with("169.254.") && ip != "127.0.0.1")
                .collect();
            if report.mac_primary.is_none() {
                report.mac_primary = mac.clone();
            }
            adapters.push(json!({ "mac": mac, "ipv4": ipv4 }));
        }
    }

    report.peripherals = collect_peripherals(&wmi, com);
    report.printers = collect_printers(&wmi);

    let collected_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    report.extended = json!({
        "agent_version": "tray-1.1.0",
        "profile": "tray",
        "collected_at": collected_at,
        "partial": false,
        "network": { "adapters": adapters },
    });
    Ok(report)
}

fn collect_software(max: usize) -> Vec<Value> {
    use winreg::enums::*;
    use winreg::RegKey;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let paths = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    for hive in [&hklm, &hkcu] {
        for path in paths {
            let Ok(key) = hive.open_subkey_with_flags(path, KEY_READ) else { continue };
            for name in key.enum_keys().filter_map(|x| x.ok()) {
                if out.len() >= max {
                    break;
                }
                let Ok(sub) = key.open_subkey_with_flags(&name, KEY_READ) else { continue };
                let Ok(display) = sub.get_value::<String, _>("DisplayName") else { continue };
                let name = display.trim().to_string();
                if name.is_empty() {
                    continue;
                }
                let ver: Option<String> = sub.get_value("DisplayVersion").ok();
                let dedupe = format!(
                    "{}|{}",
                    name.to_lowercase(),
                    ver.as_deref().unwrap_or("").to_lowercase()
                );
                if !seen.insert(dedupe) {
                    continue;
                }
                out.push(json!({ "name": name, "version": ver }));
            }
        }
    }
    out.sort_by(|a, b| {
        a.get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_lowercase()
            .cmp(
                &b.get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_lowercase(),
            )
    });
    out
}

fn push_peripheral(out: &mut Vec<Value>, seen: &mut HashSet<String>, kind: &str, name: Option<String>) {
    let Some(name) = nz(name) else { return };
    let name: String = name.chars().take(512).collect();
    if is_noise_peripheral(kind, &name) {
        return;
    }
    if kind == "monitor" && !is_real_monitor_name(&name) {
        return;
    }
    let key = format!("{}|{}", kind, name.to_lowercase());
    if !seen.insert(key) {
        return;
    }
    if out.len() >= 200 {
        return;
    }
    out.push(json!({ "kind": kind, "name": name }));
}

fn pnp_kind(class: &str) -> Option<&'static str> {
    match class.trim().to_ascii_lowercase().as_str() {
        "keyboard" => Some("keyboard"),
        "mouse" => Some("mouse"),
        "monitor" | "display" => Some("monitor"),
        "image" | "camera" | "imaging" => Some("camera"),
        "audioendpoint" | "media" | "midi" | "sound" | "audio" | "audioprocessingobject" => {
            Some("audio")
        }
        "printer" | "printqueue" => Some("printer"),
        "biometric" => Some("biometric"),
        "bluetooth" => Some("bluetooth"),
        "net" => Some("net"),
        "pointerclass" => Some("touchpad"),
        "wpd" | "portabledevices" | "softwaredevice" | "usb" | "hidclass" | "hid" => None,
        _ => None,
    }
}

fn kind_from_guid(guid: &str) -> Option<&'static str> {
    let g = guid
        .trim()
        .trim_matches('{')
        .trim_matches('}')
        .to_ascii_lowercase();
    match g.as_str() {
        "c166523c-fe0c-4a94-8341-a82bd291d73e" => Some("audio"), // AudioEndpoint
        "4d36e96c-e325-11ce-bfc1-08002be10318" => Some("audio"), // MEDIA / sound
        "4d36e96b-e325-11ce-bfc1-08002be10318" => Some("keyboard"),
        "4d36e96f-e325-11ce-bfc1-08002be10318" => Some("mouse"),
        "4d36e96e-e325-11ce-bfc1-08002be10318" => Some("monitor"),
        "6bdd1fc6-810f-11d0-bec7-08002be2092f" => Some("camera"), // Image
        "ca3e7ab9-b4c3-4ae6-8251-579ef933890f" => Some("camera"),
        "4d36e979-e325-11ce-bfc1-08002be10318" => Some("printer"),
        "4d36e97a-e325-11ce-bfc1-08002be10318" => Some("printer"),
        "e0cbf06c-cd8b-4647-bb8a-263b43f0f974" => Some("bluetooth"),
        "53d29ef7-377c-4d14-864b-eb3a85769359" => Some("biometric"),
        "4d36e972-e325-11ce-bfc1-08002be10318" => Some("net"),
        _ => None,
    }
}

fn infer_kind_from_name(name: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    if n.contains("webcam")
        || n.contains("web cam")
        || n.contains("camera")
        || n.contains("камер")
        || n.contains("камера")
    {
        return Some("camera");
    }
    if n.contains("headset")
        || n.contains("headphone")
        || n.contains("earphone")
        || n.contains("гарнитур")
        || n.contains("наушник")
        || n.contains("microphone")
        || n.contains("микрофон")
        || n.contains("speaker")
        || n.contains("динамик")
        || n.contains("realtek")
        || n.contains("high definition audio")
        || n.contains("hd audio")
        || n.contains("sound")
        || n.contains(" audio")
        || n.contains("звук")
    {
        return Some("audio");
    }
    None
}

fn is_noise_audio(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("mapper")
        || n.contains("audio processing")
        || n.contains("microsoft streaming")
        || n.contains("dummy")
        || n.contains("vad ")
        || n == "stereo mix"
        || n.contains("wave synthesizer")
}

fn is_real_monitor_name(name: &str) -> bool {
    let n = name.trim().to_lowercase();
    if n.is_empty() {
        return false;
    }
    if n.contains("pnp") {
        return false;
    }
    if n.contains("generic") && n.contains("monitor") {
        return false;
    }
    if n.contains("nvidia")
        || n.contains("radeon")
        || n.contains("geforce")
        || n.contains("display adapter")
        || n.contains("basic display")
        || n.contains("remote display")
        || n.contains("mirror")
        || n.contains("dameware")
    {
        return false;
    }
    if n.contains("intel") && n.contains("graphics") {
        return false;
    }
    true
}

fn is_noise_peripheral(kind: &str, name: &str) -> bool {
    let n = name.trim().to_lowercase();
    if n.is_empty() {
        return true;
    }
    match kind {
        "net" => {
            n.starts_with("wan miniport")
                || n.contains("pppoe")
                || n.contains("pptp")
                || n.contains("sstp")
                || n.contains("l2tp")
                || n.contains("ikev2")
                || n.contains("isatap")
                || n.contains("teredo")
                || n.contains("6to4")
                || n.contains("wi-fi direct")
                || n.contains("wifi direct")
                || n.contains("kernel debug")
                || n.contains("hyper-v")
                || n.contains("hyperv")
                || n.contains("vmware")
                || n.contains("virtualbox")
                || n.contains("virtual ethernet")
                || n.contains("virtual switch")
                || n.contains("tap")
                || n.contains("tunnel")
                || n.contains("loopback")
                || n.contains("vpn")
                || n.contains("wintun")
        }
        "keyboard" | "mouse" => n.contains("dameware"),
        "printer" => skip_virtual_printer(&n) || n.contains("корневая очередь") || n == "print queue root",
        "audio" => is_noise_audio(&n),
        _ => false,
    }
}

fn kind_rank(kind: &str) -> u8 {
    match kind {
        "monitor" => 0,
        "printer" => 1,
        "keyboard" => 2,
        "mouse" => 3,
        "camera" => 4,
        "audio" => 5,
        "biometric" => 6,
        "bluetooth" => 7,
        "touchpad" => 8,
        "net" => 9,
        _ => 99,
    }
}

fn variant_chars(v: &Variant) -> String {
    match v {
        Variant::String(s) => s.trim().to_string(),
        Variant::Array(items) => {
            let mut out = String::new();
            for item in items {
                let code = match item {
                    Variant::UI2(n) => *n as u32,
                    Variant::I2(n) if *n > 0 => *n as u32,
                    Variant::UI4(n) => *n,
                    Variant::I4(n) if *n > 0 => *n as u32,
                    Variant::UI1(n) => *n as u32,
                    _ => 0,
                };
                if code == 0 {
                    continue;
                }
                if let Some(ch) = char::from_u32(code) {
                    if !ch.is_control() {
                        out.push(ch);
                    }
                }
            }
            out.trim().to_string()
        }
        _ => String::new(),
    }
}

fn map_var<'a>(row: &'a HashMap<String, Variant>, key: &str) -> Option<&'a Variant> {
    row.get(key).or_else(|| {
        row.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v)
    })
}

fn edid_monitor_name(edid: &[u8]) -> Option<String> {
    if edid.len() < 128 {
        return None;
    }
    let mut model = String::new();
    for off in [54usize, 72, 90, 108] {
        if off + 18 > edid.len() {
            break;
        }
        if edid[off] == 0 && edid[off + 1] == 0 && edid[off + 2] == 0 && edid[off + 3] == 0xFC {
            let mut name = String::new();
            for i in 0..13 {
                let c = edid[off + 5 + i];
                if c == 0x0A || c == 0 {
                    break;
                }
                name.push(if (32..127).contains(&c) { c as char } else { ' ' });
            }
            model = name.trim().to_string();
            break;
        }
    }
    let b1 = edid[8] as u32;
    let b2 = edid[9] as u32;
    let mfr: String = [
        char::from_u32(((b1 >> 2) & 0x1F) + ('A' as u32) - 1).unwrap_or('?'),
        char::from_u32((((b1 & 3) << 3) | ((b2 >> 5) & 7)) + ('A' as u32) - 1).unwrap_or('?'),
        char::from_u32((b2 & 0x1F) + ('A' as u32) - 1).unwrap_or('?'),
    ]
    .into_iter()
    .collect();
    let mfr = mfr.trim().to_string();
    let mut out = mfr;
    if !model.is_empty() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&model);
    }
    let out = out.trim().to_string();
    if is_real_monitor_name(&out) {
        Some(out)
    } else {
        None
    }
}

fn collect_monitors_from_edid_registry(out: &mut Vec<Value>, seen: &mut HashSet<String>) {
    use winreg::enums::*;
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let Ok(display) = hklm.open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Enum\DISPLAY", KEY_READ)
    else {
        return;
    };
    for mfr in display.enum_keys().filter_map(|x| x.ok()) {
        let Ok(mfr_key) = display.open_subkey_with_flags(&mfr, KEY_READ) else {
            continue;
        };
        for inst in mfr_key.enum_keys().filter_map(|x| x.ok()) {
            let Ok(inst_key) = mfr_key.open_subkey_with_flags(&inst, KEY_READ) else {
                continue;
            };
            let Ok(dp) = inst_key.open_subkey_with_flags("Device Parameters", KEY_READ) else {
                continue;
            };
            let Ok(val) = dp.get_raw_value("EDID") else {
                continue;
            };
            if let Some(name) = edid_monitor_name(&val.bytes) {
                push_peripheral(out, seen, "monitor", Some(name));
            }
        }
    }
}

fn collect_peripherals(wmi: &wmi::WMIConnection, com: wmi::COMLibrary) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    let pnp_q = "SELECT Name, Caption, Description, PNPClass, ClassGuid, ConfigManagerErrorCode FROM Win32_PnPEntity WHERE ConfigManagerErrorCode = 0";
    let pnp_rows = match wmi.raw_query::<Win32_PnPEntity>(pnp_q) {
        Ok(rows) => rows,
        Err(_) => wmi.query::<Win32_PnPEntity>().unwrap_or_default(),
    };
    for row in pnp_rows {
        if row.ConfigManagerErrorCode.unwrap_or(0) != 0 {
            continue;
        }
        let name = row.Name.or(row.Caption).or(row.Description);
        let class = nz(row.PNPClass).or_else(|| nz(row.Class)).unwrap_or_default();
        let kind = pnp_kind(&class)
            .or_else(|| kind_from_guid(row.ClassGuid.as_deref().unwrap_or("")))
            .or_else(|| name.as_deref().and_then(infer_kind_from_name));
        let Some(kind) = kind else { continue };
        push_peripheral(&mut out, &mut seen, kind, name);
    }

    if let Ok(rows) = wmi.query::<Win32_SoundDevice>() {
        for row in rows {
            push_peripheral(
                &mut out,
                &mut seen,
                "audio",
                row.ProductName.or(row.Name),
            );
        }
    }

    if let Ok(root) = wmi::WMIConnection::with_namespace_path("ROOT\\WMI", com) {
        if let Ok(rows) = root.raw_query::<HashMap<String, Variant>>(
            "SELECT ManufacturerName, UserFriendlyName, SerialNumberID FROM WmiMonitorID",
        ) {
            for row in rows {
                let mut parts = Vec::new();
                if let Some(v) = map_var(&row, "ManufacturerName") {
                    let s = variant_chars(v);
                    if !s.is_empty() {
                        parts.push(s);
                    }
                }
                if let Some(v) = map_var(&row, "UserFriendlyName") {
                    let s = variant_chars(v);
                    if !s.is_empty() {
                        parts.push(s);
                    }
                }
                if let Some(v) = map_var(&row, "SerialNumberID") {
                    let s = variant_chars(v);
                    if !s.is_empty() {
                        parts.push(format!("SN:{s}"));
                    }
                }
                let name = parts.join(" ");
                push_peripheral(&mut out, &mut seen, "monitor", Some(name));
            }
        }
    }

    let has_monitor = out.iter().any(|p| p.get("kind").and_then(|x| x.as_str()) == Some("monitor"));
    if !has_monitor {
        collect_monitors_from_edid_registry(&mut out, &mut seen);
    }
    if !out.iter().any(|p| p.get("kind").and_then(|x| x.as_str()) == Some("monitor")) {
        if let Ok(rows) = wmi.query::<Win32_DesktopMonitor>() {
            for row in rows {
                push_peripheral(&mut out, &mut seen, "monitor", row.Name);
            }
        }
    }

    if !out.iter().any(|p| p.get("kind").and_then(|x| x.as_str()) == Some("keyboard")) {
        if let Ok(rows) = wmi.query::<Win32_Keyboard>() {
            for row in rows {
                push_peripheral(&mut out, &mut seen, "keyboard", row.Name.or(row.Description));
            }
        }
    }
    if !out.iter().any(|p| p.get("kind").and_then(|x| x.as_str()) == Some("mouse")) {
        if let Ok(rows) = wmi.query::<Win32_PointingDevice>() {
            for row in rows {
                push_peripheral(&mut out, &mut seen, "mouse", row.Name.or(row.Description));
            }
        }
    }

    out.sort_by(|a, b| {
        let ka = a.get("kind").and_then(|x| x.as_str()).unwrap_or("other");
        let kb = b.get("kind").and_then(|x| x.as_str()).unwrap_or("other");
        kind_rank(ka)
            .cmp(&kind_rank(kb))
            .then_with(|| {
                a.get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_lowercase()
                    .cmp(&b.get("name").and_then(|x| x.as_str()).unwrap_or("").to_lowercase())
            })
    });
    out
}

fn looks_like_ipv4(raw: &str) -> Option<String> {
    let t = raw
        .trim()
        .trim_start_matches("IP_")
        .trim_start_matches("ip_");
    let parts: Vec<&str> = t.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut nums = [0u8; 4];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        nums[i] = p.parse().ok()?;
    }
    Some(format!("{}.{}.{}.{}", nums[0], nums[1], nums[2], nums[3]))
}

fn skip_virtual_printer(name: &str) -> bool {
    let u = name.to_ascii_lowercase();
    u == "fax"
        || u.contains("onenote")
        || u.contains("xps")
        || u.contains("pdf")
        || u.contains("onenote")
        || u.contains("send to")
}

fn collect_printers(wmi: &wmi::WMIConnection) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(rows) = wmi.query::<Win32_Printer>() else {
        return out;
    };
    for row in rows {
        let Some(name) = nz(row.Name) else { continue };
        if skip_virtual_printer(&name) {
            continue;
        }
        let port = nz(row.PortName);
        let ip = port.as_ref().and_then(|p| looks_like_ipv4(p));
        out.push(json!({
            "name": name.chars().take(512).collect::<String>(),
            "driver_name": nz(row.DriverName).map(|s| s.chars().take(512).collect::<String>()),
            "port_name": port.as_ref().map(|s| s.chars().take(512).collect::<String>()),
            "shared": row.Shared.unwrap_or(false),
            "is_default": row.Default.unwrap_or(false),
            "is_network": row.Network,
            "ip_address": ip,
            "status_code": row.PrinterStatus,
            "work_offline": row.WorkOffline,
        }));
    }
    out
}

pub fn post_inventory(server: &str, token: &str, report: &InventoryReport) -> Result<String, String> {
    let base = server.trim().trim_end_matches('/');
    let url = format!("{base}/api/v1/agent/inventory");
    let body = serde_json::to_string(report).map_err(|e| e.to_string())?;
    match ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {token}"))
        .send_string(&body)
    {
        Ok(resp) => {
            let status = resp.status();
            let text = resp.into_string().unwrap_or_default();
            if (200..300).contains(&status) {
                Ok(text)
            } else {
                Err(explain_http(status, &text, token))
            }
        }
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(explain_http(code, &text, token))
        }
        Err(e) => Err(e.to_string()),
    }
}

fn explain_http(code: u16, text: &str, token: &str) -> String {
    let short = text.chars().take(240).collect::<String>();
    let prefix = token.split('.').next().unwrap_or("").chars().take(8).collect::<String>();
    match code {
        401 | 403 => format!(
            "HTTP 403: сервер не принял токен (префикс {prefix}). Скачайте ZIP заново со страницы «Сборка агента» и запускайте EXE из этой распаковки."
        ),
        422 => format!("HTTP 422: сервер отклонил состав отчёта. {short}"),
        _ => format!("HTTP {code}: {short}"),
    }
}
