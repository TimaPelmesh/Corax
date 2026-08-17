#!/bin/sh
# CORAX Agent — common helpers (POSIX-friendly)
# SAFETY: never delete anything outside an exact /tmp/corax-agent.<id> directory.
# Never touch .env, databases, docker volumes, or the agent install tree.
# shellcheck shell=sh

CORAX_AGENT_VERSION="${CORAX_AGENT_VERSION:-3.1.2-linux}"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)" "$*" >&2
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

read_file() {
  if [ -r "$1" ]; then
    tr -d '\000' <"$1" 2>/dev/null || true
  fi
}

trim() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

os_release_val() {
  key="$1"
  file="${2:-/etc/os-release}"
  [ -r "$file" ] || return 0
  # shellcheck disable=SC2162
  while IFS= read line || [ -n "$line" ]; do
    case "$line" in
      "$key="*)
        val=${line#*=}
        val=$(printf '%s' "$val" | sed 's/^"//;s/"$//')
        printf '%s' "$val"
        return 0
        ;;
    esac
  done <"$file"
}

dmi_is_junk() {
  v=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -n "$v" ] || return 0
  printf '%s' "$v" | grep -Eq '^(none|null|nil|unknown|undefined|invalid|oem|n/?a|not specified|not available|not applicable|no asset tag|default string|to be filled by o\.?e\.?m\.?|to be filled by oem|to be filled|system manufacturer|system product name|system serial number|system version|system sku|product name|base board|baseboard)$'
}

dmi_read_sysfs() {
  key="$1"
  for path in "/sys/class/dmi/id/$key" "/sys/devices/virtual/dmi/id/$key"; do
    [ -r "$path" ] || continue
    val=$(trim "$(read_file "$path" | tr -d '\000' | head -n 1)")
    if ! dmi_is_junk "$val"; then
      printf '%s' "$val"
      return 0
    fi
  done
  return 1
}

dmi_string() {
  key="$1"
  val=$(dmi_read_sysfs "$key" || true)
  if [ -n "$val" ]; then
    printf '%s' "$val"
    return 0
  fi
  if have_cmd dmidecode; then
    dmikey=""
    case "$key" in
      product_serial) dmikey=system-serial-number ;;
      product_name) dmikey=system-product-name ;;
      sys_vendor) dmikey=system-manufacturer ;;
      board_vendor) dmikey=baseboard-manufacturer ;;
      board_name) dmikey=baseboard-product-name ;;
      bios_vendor) dmikey=bios-vendor ;;
      bios_version) dmikey=bios-version ;;
      chassis_vendor) dmikey=chassis-manufacturer ;;
    esac
    if [ -n "$dmikey" ]; then
      val=$(trim "$(dmidecode -s "$dmikey" 2>/dev/null | grep -v '^#' | head -n 1)")
      if ! dmi_is_junk "$val"; then
        printf '%s' "$val"
        return 0
      fi
    fi
  fi
  case "$key" in
    product_name | board_name)
      if [ -r /proc/device-tree/model ]; then
        val=$(trim "$(tr -d '\000' </proc/device-tree/model)")
        if ! dmi_is_junk "$val"; then
          printf '%s' "$val"
          return 0
        fi
      fi
      ;;
    sys_vendor | board_vendor)
      if [ -r /proc/device-tree/compatible ]; then
        val=$(trim "$(tr -d '\000' </proc/device-tree/compatible | tr '\n' ' ')")
        val=${val%%,*}
        if ! dmi_is_junk "$val"; then
          printf '%s' "$val"
          return 0
        fi
      fi
      ;;
  esac
}

module_on() {
  name="$1"
  eval "v=\${CORAX_MOD_${name}:-1}"
  case "$v" in
    0|false|False|no|NO|off|OFF) return 1 ;;
    *) return 0 ;;
  esac
}

# True if path is a safe disposable temp dir we created.
is_safe_corax_tmpdir() {
  p=$1
  # Exact pattern only — no parent paths, no /opt, no .
  printf '%s' "$p" | grep -Eq '^/tmp/corax-agent\.[A-Za-z0-9._-]+$'
}

# Create workdir ONLY as /tmp/corax-agent.XXXXXX (ignore TMPDIR / CORAX_WORKDIR env).
ensure_workdir() {
  unset CORAX_WORKDIR 2>/dev/null || true
  CORAX_WORKDIR=$(mktemp -d /tmp/corax-agent.XXXXXX 2>/dev/null || true)
  if [ -z "$CORAX_WORKDIR" ] || [ ! -d "$CORAX_WORKDIR" ]; then
    log "ERROR: cannot create /tmp/corax-agent.* (check /tmp permissions)"
    return 1
  fi
  if ! is_safe_corax_tmpdir "$CORAX_WORKDIR"; then
    log "ERROR: unexpected temp path '$CORAX_WORKDIR' — refusing to use it"
    return 1
  fi
  # Mark so we only delete our own marker file tree
  printf 'corax-agent-workdir\n' >"$CORAX_WORKDIR/.corax_workdir" 2>/dev/null || true
  export CORAX_WORKDIR
  return 0
}

# SAFE cleanup: only remove /tmp/corax-agent.<id> that we marked. Never rm -rf anything else.
cleanup_workdir() {
  wd=${CORAX_WORKDIR:-}
  CORAX_WORKDIR=
  export CORAX_WORKDIR
  [ -n "$wd" ] || return 0
  if ! is_safe_corax_tmpdir "$wd"; then
    log "SKIP cleanup: path not a safe temp dir ($wd)"
    return 0
  fi
  if [ ! -f "$wd/.corax_workdir" ]; then
    log "SKIP cleanup: missing .corax_workdir marker ($wd)"
    return 0
  fi
  # Delete only contents via find, then the dir — still constrained to verified path
  find "$wd" -mindepth 1 -maxdepth 5 -exec rm -f {} + 2>/dev/null || true
  find "$wd" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  rmdir "$wd" 2>/dev/null || true
}

is_placeholder() {
  v=$1
  case "$v" in
    '' | '__INVENTORY_SERVER__' | '__AGENT_TOKEN__' | 'xxxx.yyyy')
      return 0
      ;;
  esac
  case "$v" in
    *__*) return 0 ;;
  esac
  return 1
}

# Refuse to run from inside the CORAX server tree (protects prod .env / compose).
refuse_if_inside_corax_server() {
  root=${AGENT_ROOT:-}
  [ -n "$root" ] || return 0
  # Walk up a few levels looking for production markers
  d=$root
  i=0
  while [ "$i" -lt 6 ] && [ -n "$d" ] && [ "$d" != "/" ]; do
    if [ -f "$d/docker-compose.yml" ] || [ -f "$d/backend/.env" ] || [ -f "$d/run.py" ]; then
      if [ "${CORAX_AGENT_ALLOW_IN_SOURCE:-0}" != "1" ]; then
        log "ERROR: агент запущен из дерева CORAX-сервера: $root"
        log "  Так делать нельзя — риск затронуть прод. Распакуйте ZIP в /opt/corax-agent"
        log "  (отдельная папка). Или CORAX_AGENT_ALLOW_IN_SOURCE=1 (не рекомендуется)."
        return 2
      fi
      log "WARN: running inside CORAX server tree (CORAX_AGENT_ALLOW_IN_SOURCE=1)"
      return 0
    fi
    d=$(dirname "$d")
    i=$((i + 1))
  done
  return 0
}

require_agent_config() {
  base=$1
  token=$2
  if [ ! -f "$AGENT_ROOT/agent_env.sh" ]; then
    log "ERROR: нет agent_env.sh"
    log "  Скачайте ZIP: панель → Сборка агента → ZIP Linux (bash)"
    log "  или: cp agent_env.sh.example agent_env.sh и пропишите URL/токен"
    return 2
  fi
  if is_placeholder "$base" || ! printf '%s' "$base" | grep -Eq '^https?://[^/]+'; then
    log "ERROR: INVENTORY_SERVER неверный или плейсхолдер: '$base'"
    return 2
  fi
  if is_placeholder "$token" || [ "${#token}" -lt 8 ]; then
    log "ERROR: AGENT_TOKEN не задан или плейсхолдер"
    return 2
  fi
  return 0
}
