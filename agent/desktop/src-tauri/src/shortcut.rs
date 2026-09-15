use image::{ImageEncoder, Rgba, RgbaImage};
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

fn icon_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
        std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()) + r"\AppData\Local"
    });
    PathBuf::from(base).join("CORAX").join("desktop")
}

fn px(img: &mut RgbaImage, x: i32, y: i32, c: Rgba<u8>) {
    if x >= 0 && y >= 0 && (x as u32) < img.width() && (y as u32) < img.height() {
        let dest = img.get_pixel_mut(x as u32, y as u32);
        let a = c.0[3] as u32;
        if a == 0 {
            return;
        }
        if a == 255 {
            *dest = c;
            return;
        }
        let ia = 255 - a;
        dest.0[0] = ((c.0[0] as u32 * a + dest.0[0] as u32 * ia) / 255) as u8;
        dest.0[1] = ((c.0[1] as u32 * a + dest.0[1] as u32 * ia) / 255) as u8;
        dest.0[2] = ((c.0[2] as u32 * a + dest.0[2] as u32 * ia) / 255) as u8;
        dest.0[3] = dest.0[3].max(c.0[3]);
    }
}

fn fill_round_rect(img: &mut RgbaImage, x0: i32, y0: i32, x1: i32, y1: i32, r: i32, c: Rgba<u8>) {
    for y in y0..=y1 {
        for x in x0..=x1 {
            let dx = if x < x0 + r {
                x0 + r - x
            } else if x > x1 - r {
                x - (x1 - r)
            } else {
                0
            };
            let dy = if y < y0 + r {
                y0 + r - y
            } else if y > y1 - r {
                y - (y1 - r)
            } else {
                0
            };
            if dx * dx + dy * dy <= r * r {
                px(img, x, y, c);
            }
        }
    }
}

fn helpdesk_png() -> Vec<u8> {
    let mut img = RgbaImage::from_pixel(32, 32, Rgba([0, 0, 0, 0]));
    let blue = Rgba([59, 130, 246, 255]);
    let white = Rgba([255, 255, 255, 255]);
    let peach = Rgba([251, 146, 60, 255]);
    fill_round_rect(&mut img, 1, 1, 30, 30, 8, blue);
    fill_round_rect(&mut img, 7, 6, 25, 20, 4, white);
    fill_round_rect(&mut img, 10, 9, 22, 11, 1, blue);
    fill_round_rect(&mut img, 10, 13, 20, 15, 1, blue);
    fill_round_rect(&mut img, 10, 17, 17, 19, 1, peach);
    fill_round_rect(&mut img, 12, 20, 16, 26, 2, white);
    let mut png = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png);
    let _ = encoder.write_image(img.as_raw(), 32, 32, image::ExtendedColorType::Rgba8);
    png
}

fn png_to_ico(png: &[u8]) -> Vec<u8> {
    let mut ico = Vec::new();
    ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
    ico.extend_from_slice(&[32, 32, 0, 0, 1, 0, 32, 0]);
    ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    ico.extend_from_slice(png);
    ico
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
        "[InternetShortcut]\r\nURL={url}\r\nIconFile={}\r\nIconIndex=0\r\n",
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
    let icons = icon_dir();
    fs::create_dir_all(&icons).map_err(|e| e.to_string())?;
    let ico_path = icons.join("helpdesk.ico");
    fs::write(&ico_path, png_to_ico(&helpdesk_png())).map_err(|e| e.to_string())?;
    let path = write_url_shortcut(&desk, &url, &ico_path)?;
    Ok(format!("{}\n{}", path.display(), url))
}
