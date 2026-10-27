#!/bin/sh
# Minimal JSON emit without Python (core fields only) — jq or pure sh
# shellcheck shell=sh

json_escape() {
  printf '%s' "$1" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/"/\\"/g' \
    -e 's/'"$(printf '\t')"'/\\t/g' \
    -e ':a;N;$!ba;s/\n/\\n/g'
}

emit_report_minimal() {
  out="$1"
  mh() { cat "$CORAX_WORKDIR/meta/$1" 2>/dev/null || true; }

  hostname=$(mh hostname)
  [ -n "$hostname" ] || hostname="unknown-host"
  serial=$(mh serial_number)
  mac=$(mh mac_primary)
  cpu=$(mh cpu)
  ram=$(mh ram_gb)
  os_name=$(mh os_name)
  os_ver=$(mh os_version)
  mfr=$(mh manufacturer)
  model=$(mh model)
  gpu=$(mh gpu_name)
  mempct=$(mh memory_used_percent)
  mb_mfr=$(mh motherboard_manufacturer)
  mb_prod=$(mh motherboard_product)
  agent_ver=$(mh agent_version)
  collected=$(mh collected_at)
  primary_ip=$(mh primary_ip)

  # software array (cap 800 for size)
  soft="["
  first=1
  i=0
  while IFS="$(printf '\t')" read -r n v || [ -n "$n" ]; do
    [ -n "$n" ] || continue
    i=$((i + 1))
    [ "$i" -gt 800 ] && break
    [ "$first" -eq 1 ] || soft="$soft,"
    first=0
    ne=$(json_escape "$n")
    if [ -n "$v" ]; then
      ve=$(json_escape "$v")
      soft="$soft{\"name\":\"$ne\",\"version\":\"$ve\"}"
    else
      soft="$soft{\"name\":\"$ne\",\"version\":null}"
    fi
  done <"$CORAX_WORKDIR/software.tsv"
  soft="$soft]"

  disks="["
  first=1
  while IFS="$(printf '\t')" read -r mnt _lab tg up fg || [ -n "$mnt" ]; do
    [ -n "$mnt" ] || continue
    [ "$first" -eq 1 ] || disks="$disks,"
    first=0
    me=$(json_escape "$mnt")
    disks="$disks{\"mount\":\"$me\",\"total_gb\":$tg,\"used_percent\":$up,\"free_gb\":$fg}"
  done <"$CORAX_WORKDIR/disks.tsv"
  disks="$disks]"

  null_or_str() {
    if [ -n "$1" ]; then
      printf '"%s"' "$(json_escape "$1")"
    else
      printf 'null'
    fi
  }
  null_or_num() {
    if [ -n "$1" ]; then
      printf '%s' "$1"
    else
      printf 'null'
    fi
  }

  {
    printf '{'
    printf '"hostname":"%s",' "$(json_escape "$hostname")"
    printf '"serial_number":%s,' "$(null_or_str "$serial")"
    printf '"mac_primary":%s,' "$(null_or_str "$mac")"
    printf '"cpu":%s,' "$(null_or_str "$cpu")"
    printf '"ram_gb":%s,' "$(null_or_num "$ram")"
    printf '"os_name":%s,' "$(null_or_str "$os_name")"
    printf '"os_version":%s,' "$(null_or_str "$os_ver")"
    printf '"manufacturer":%s,' "$(null_or_str "$mfr")"
    printf '"model":%s,' "$(null_or_str "$model")"
    printf '"gpu_name":%s,' "$(null_or_str "$gpu")"
    printf '"memory_used_percent":%s,' "$(null_or_num "$mempct")"
    printf '"motherboard_manufacturer":%s,' "$(null_or_str "$mb_mfr")"
    printf '"motherboard_product":%s,' "$(null_or_str "$mb_prod")"
    printf '"disks":%s,' "$disks"
    printf '"software":%s,' "$soft"
    printf '"peripherals":[],'
    printf '"printers":[],'
    printf '"extended":{'
    printf '"agent_version":%s,' "$(null_or_str "$agent_ver")"
    printf '"platform":"linux",'
    printf '"collected_at":%s,' "$(null_or_str "$collected")"
    printf '"network":{"primary_ip":%s}' "$(null_or_str "$primary_ip")"
    printf '}'
    printf '}\n'
  } >"$out"
}
