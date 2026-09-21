use std::fs;
use std::path::{Path, PathBuf};

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn user_desktop() -> Option<PathBuf> {
    if let Ok(hku) = std::env::var("USERPROFILE") {
        let d = PathBuf::from(hku).join("Desktop");
        if d.is_dir() {
            return Some(d);
        }
    }
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
        winreg::enums::KEY_READ,
    ) {
        if let Ok(p) = key.get_value::<String, _>("Desktop") {
            let expanded = p.replace("%USERPROFILE%", &std::env::var("USERPROFILE").unwrap_or_default());
            let d = PathBuf::from(expanded);
            if d.is_dir() {
                return Some(d);
            }
        }
    }
    None
}

/// Classic Windows document from SHELL32.dll (index 1).
fn shell32_dll() -> PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    PathBuf::from(root).join("System32").join("SHELL32.dll")
}

fn write_utf16_le(path: &Path, text: &str) -> Result<(), String> {
    let mut bytes = vec![0xFF, 0xFE];
    for u in text.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    fs::write(path, bytes).map_err(|e| e.to_string())
}

fn write_url_shortcut(dir: &Path, url: &str, icon: &Path) -> Result<PathBuf, String> {
    let path = dir.join("Оставить заявку.url");
    let body = format!(
        "[InternetShortcut]\r\nURL={url}\r\nIconFile={}\r\nIconIndex=1\r\n",
        icon.display()
    );
    write_utf16_le(&path, &body)?;
    if path.is_file() {
        Ok(path)
    } else {
        Err("не удалось записать ярлык".into())
    }
}

fn cleanup_old(dir: &Path) {
    for name in ["Заявка в IT", "Заявка CORAX", "CORAX-ticket"] {
        for ext in [".lnk", ".url"] {
            let p = dir.join(format!("{name}{ext}"));
            let _ = fs::remove_file(p);
        }
    }
}

pub fn create_helpdesk_shortcut(server_url: &str) -> Result<String, String> {
    let base = server_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("сначала укажите IP сервера".into());
    }
    let host = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "pc".into());
    let url = format!("{base}/h#pc={}", url_encode(&host));
    let desk = user_desktop().ok_or_else(|| "не найден рабочий стол".to_string())?;
    cleanup_old(&desk);
    let path = write_url_shortcut(&desk, &url, &shell32_dll())?;
    Ok(format!("{}\n{}", path.display(), url))
}
