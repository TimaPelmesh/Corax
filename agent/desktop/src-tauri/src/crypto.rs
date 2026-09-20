use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use sha2::{Digest, Sha256};

const SEAL: &[u8] = b"corax.desktop.seal.v1\0";
const AAD: &[u8] = b"corax-agent";

pub const SEAL_BEGIN: &[u8] = b"<<<CORAX_DESKTOP_SEAL_BEGIN>>>";
pub const SEAL_END: &[u8] = b"<<<CORAX_DESKTOP_SEAL_END>>>";
pub const SEAL_SLOT_LEN: usize = 2048;

const fn make_seal_slot() -> [u8; SEAL_SLOT_LEN] {
    let mut b = [b' '; SEAL_SLOT_LEN];
    let mut i = 0;
    while i < SEAL_BEGIN.len() {
        b[i] = SEAL_BEGIN[i];
        i += 1;
    }
    let start = SEAL_SLOT_LEN - SEAL_END.len();
    let mut j = 0;
    while j < SEAL_END.len() {
        b[start + j] = SEAL_END[j];
        j += 1;
    }
    b
}

/// Padded PE slot. The panel ZIP packer writes AES-GCM JSON between the markers.
#[used]
#[no_mangle]
pub static CORAX_DESKTOP_SEAL: [u8; SEAL_SLOT_LEN] = make_seal_slot();

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| e.to_string())
}

pub fn unseal_token(wrap_b64: &str, nonce_b64: &str, ct_b64: &str) -> Result<String, String> {
    let wrap = b64_decode(wrap_b64)?;
    let nonce_raw = b64_decode(nonce_b64)?;
    let ct = b64_decode(ct_b64)?;
    if nonce_raw.len() != 12 {
        return Err("bad nonce".into());
    }
    let mut hasher = Sha256::new();
    hasher.update(SEAL);
    hasher.update(&wrap);
    let key = hasher.finalize();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&nonce_raw);
    let pt = cipher
        .decrypt(
            nonce,
            Payload {
                msg: &ct,
                aad: AAD,
            },
        )
        .map_err(|_| "не удалось расшифровать токен".to_string())?;
    String::from_utf8(pt).map_err(|e| e.to_string())
}

fn find_sub(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() || needle.is_empty() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| from + p)
}

fn find_slot_inner(bytes: &[u8]) -> Option<&[u8]> {
    const SLOT_INNER: usize = SEAL_SLOT_LEN - SEAL_BEGIN.len() - SEAL_END.len();
    let mut best: Option<(usize, usize, usize)> = None;
    let mut start = 0;
    while let Some(off) = find_sub(bytes, SEAL_BEGIN, start) {
        let inner = off + SEAL_BEGIN.len();
        if let Some(end) = find_sub(bytes, SEAL_END, inner) {
            let cap = end.saturating_sub(inner);
            if (256..=4096).contains(&cap) {
                let dist = cap.abs_diff(SLOT_INNER);
                if best.map(|b| dist < b.0).unwrap_or(true) {
                    best = Some((dist, inner, end));
                }
            }
        }
        start = off + 1;
    }
    let (_, inner, end) = best?;
    Some(&bytes[inner..end])
}

pub fn token_from_bytes(bytes: &[u8]) -> Option<String> {
    let slice = find_slot_inner(bytes)?;
    let cut = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
    let json = std::str::from_utf8(&slice[..cut]).ok()?.trim();
    if json.is_empty() || !json.starts_with('{') {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let wrap = v.get("wrap")?.as_str()?;
    let nonce = v.get("nonce")?.as_str()?;
    let ct = v.get("ct")?.as_str()?;
    unseal_token(wrap, nonce, ct).ok()
}

pub fn token_from_current_exe() -> Option<String> {
    let _keep = CORAX_DESKTOP_SEAL[0];
    let path = std::env::current_exe().ok()?;
    if let Ok(bytes) = std::fs::read(path) {
        if let Some(t) = token_from_bytes(&bytes) {
            return Some(t);
        }
    }
    token_from_bytes(&CORAX_DESKTOP_SEAL)
}
