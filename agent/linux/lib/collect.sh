#!/bin/sh
# CORAX Agent — collect inventory with basic Linux tools
# shellcheck shell=sh
# Expects: common.sh sourced, CORAX_WORKDIR set, modules via CORAX_MOD_*

write_kv() {
  # write_kv key value  -> $CORAX_WORKDIR/meta/key
  key="$1"
  shift
  val=$(printf '%s' "$*" | tr -d '\000' | head -c 4000)
  printf '%s' "$val" >"$CORAX_WORKDIR/meta/$key"
}

append_line() {
  # append_line file line
  printf '%s\n' "$2" >>"$1"
}

collect_hostname() {
  h=""
  if have_cmd hostname; then
    h=$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)
  fi
  if [ -z "$h" ] && [ -r /etc/hostname ]; then
    h=$(trim "$(read_file /etc/hostname | head -n 1)")
  fi
  if [ -z "$h" ] && [ -r /proc/sys/kernel/hostname ]; then
    h=$(trim "$(read_file /proc/sys/kernel/hostname)")
  fi
  [ -n "$h" ] || h="unknown-host"
  write_kv hostname "$h"
}

collect_os() {
  name=$(os_release_val PRETTY_NAME)
  if [ -z "$name" ]; then
    name=$(os_release_val NAME)
  fi
  if [ -z "$name" ] && [ -r /etc/redhat-release ]; then
    name=$(trim "$(read_file /etc/redhat-release | head -n 1)")
  fi
  if [ -z "$name" ]; then
    name="Linux"
  fi
  ver=$(os_release_val VERSION_ID)
  if [ -z "$ver" ]; then
    ver=$(uname -r 2>/dev/null || true)
  fi
  write_kv os_name "$name"
  write_kv os_version "$ver"
  write_kv kernel "$(uname -r 2>/dev/null || true)"
  write_kv arch "$(uname -m 2>/dev/null || true)"
  write_kv os_id "$(os_release_val ID)"
  write_kv os_id_like "$(os_release_val ID_LIKE)"
}

collect_cpu() {
  cpu=""
  if have_cmd lscpu; then
    cpu=$(lscpu 2>/dev/null | awk -F: '/^Model name/{gsub(/^[ \t]+/,"",$2); print $2; exit}')
  fi
  if [ -z "$cpu" ] && [ -r /proc/cpuinfo ]; then
    cpu=$(awk -F: '/^model name/{gsub(/^[ \t]+/,"",$2); print $2; exit}' /proc/cpuinfo)
  fi
  if [ -z "$cpu" ] && [ -r /proc/cpuinfo ]; then
    # ARM / RISC-V often lack model name
    cpu=$(awk -F: '/^Hardware|^cpu model|^isa/{gsub(/^[ \t]+/,"",$2); print $2; exit}' /proc/cpuinfo)
  fi
  [ -n "$cpu" ] || cpu="$(uname -m 2>/dev/null || echo cpu)"
  write_kv cpu "$cpu"

  cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo "")
  write_kv cpu_cores "$cores"
}

collect_memory() {
  # Always C locale: ru_RU awk prints "16,00" which is not a JSON number.
  mem_kb=""
  avail_kb=""
  if [ -r /proc/meminfo ]; then
    mem_kb=$(LC_ALL=C awk '/^MemTotal:/{gsub(/[^0-9]/,"",$2); print $2; exit}' /proc/meminfo)
    avail_kb=$(LC_ALL=C awk '/^MemAvailable:/{gsub(/[^0-9]/,"",$2); print $2; exit}' /proc/meminfo)
  fi
  if [ -z "$mem_kb" ] && have_cmd free; then
    mem_kb=$(LC_ALL=C free -k 2>/dev/null | awk 'NR==2 {gsub(/[^0-9]/,"",$2); print $2; exit}')
  fi
  ram_gb=$(LC_ALL=C awk -v k="$mem_kb" 'BEGIN {
    k = k + 0
    if (k <= 0) exit
    printf "%.2f", k / 1024 / 1024
  }')
  if [ -n "$ram_gb" ]; then
    write_kv ram_gb "$ram_gb"
  fi
  if [ -n "$mem_kb" ] && [ -n "$avail_kb" ]; then
    used_pct=$(LC_ALL=C awk -v t="$mem_kb" -v a="$avail_kb" 'BEGIN {
      t = t + 0; a = a + 0
      if (t > 0) printf "%d", (100 * (t - a) / t)
      else print 0
    }')
    write_kv memory_used_percent "$used_pct"
  fi
}

collect_dmi() {
  write_kv serial_number "$(dmi_string product_serial)"
  write_kv manufacturer "$(dmi_string sys_vendor)"
  write_kv model "$(dmi_string product_name)"
  mb_mfr=$(dmi_string board_vendor)
  mb_prod=$(dmi_string board_name)
  if [ -z "$mb_mfr" ]; then
    mb_mfr=$(dmi_string sys_vendor)
  fi
  if [ -z "$mb_prod" ]; then
    mb_prod=$(dmi_string product_name)
  fi
  write_kv motherboard_manufacturer "$mb_mfr"
  write_kv motherboard_product "$mb_prod"
  write_kv bios_vendor "$(dmi_string bios_vendor)"
  write_kv bios_version "$(dmi_string bios_version)"
}

collect_gpu() {
  gpu=""
  if have_cmd lspci; then
    gpu=$(lspci 2>/dev/null | awk '/VGA compatible controller|3D controller|Display controller/{
      sub(/^[^ ]+ /,""); print; exit
    }')
  fi
  if [ -z "$gpu" ]; then
    for card in /sys/class/drm/card*/device/vendor; do
      [ -r "$card" ] || continue
      gpu="DRM $(basename "$(dirname "$(dirname "$card")")")"
      break
    done
  fi
  write_kv gpu_name "$gpu"
}

collect_disks() {
  : >"$CORAX_WORKDIR/disks.tsv"
  # Prefer df -P (POSIX portable)
  if have_cmd df; then
    LC_ALL=C df -Pk 2>/dev/null | awk 'NR>1 && $6 ~ /^\// {
      total=$2+0; used=$3+0; avail=$4+0; mnt=$6
      if (total<=0) next
      # skip tiny pseudo
      if (mnt ~ /^\/(proc|sys|dev|run|snap)/) next
      tg=total/1024/1024; fg=avail/1024/1024
      pct=int((used*100)/total)
      printf "%s\t%s\t%.2f\t%d\t%.2f\n", mnt, "", tg, pct, fg
    }' >>"$CORAX_WORKDIR/disks.tsv"
  fi
}

collect_physical_disks() {
  : >"$CORAX_WORKDIR/physical_disks.tsv"
  if have_cmd lsblk; then
    lsblk -bno NAME,SIZE,TYPE,MODEL,SERIAL,ROTA,TRAN 2>/dev/null | awk '
      $3=="disk" {
        name=$1; size=$2; model=$4; serial=$5; rota=$6; tran=$7
        media=(rota=="0"||rota==0)?"SSD":"HDD"
        if (tran=="nvme") media="NVMe"
        printf "%s\t%s\t%s\t%s\t%s\n", name, size, media, model, serial
      }' >>"$CORAX_WORKDIR/physical_disks.tsv"
  elif [ -d /sys/block ]; then
    for b in /sys/block/*; do
      name=$(basename "$b")
      case "$name" in
        loop*|ram*|fd*|sr*) continue ;;
      esac
      size=$(read_file "$b/size")
      # sectors * 512
      bytes=$(awk -v s="$size" 'BEGIN{print (s+0)*512}')
      model=$(trim "$(read_file "$b/device/model" 2>/dev/null)")
      printf '%s\t%s\t\t%s\t\n' "$name" "$bytes" "$model" >>"$CORAX_WORKDIR/physical_disks.tsv"
    done
  fi
}

collect_mac_and_network() {
  : >"$CORAX_WORKDIR/adapters.tsv"
  : >"$CORAX_WORKDIR/dns.txt"
  : >"$CORAX_WORKDIR/gateways.txt"
  mac=""
  primary_ip=""

  if have_cmd ip; then
    # default route gateway
    ip -4 route show default 2>/dev/null | awk '/default/{print $3; exit}' >>"$CORAX_WORKDIR/gateways.txt"
    ip -6 route show default 2>/dev/null | awk '/default/{print $3; exit}' >>"$CORAX_WORKDIR/gateways.txt"
    # adapters
    ip -o link show 2>/dev/null | while IFS= read -r line; do
      ifname=$(printf '%s' "$line" | awk -F': ' '{print $2}' | awk '{print $1}')
      case "$ifname" in
        lo|docker*|veth*|br-*|virbr*|tun*|tap*|wg*) continue ;;
      esac
      m=$(printf '%s' "$line" | sed -n 's/.*link\/ether \([0-9a-fA-F:]*\).*/\1/p' | tr 'a-f' 'A-F')
      [ -n "$m" ] || continue
      ipv4=$(ip -4 -o addr show dev "$ifname" 2>/dev/null | awk '{print $4}' | head -n 1)
      ipv6=$(ip -6 -o addr show dev "$ifname" scope global 2>/dev/null | awk '{print $4}' | head -n 1)
      printf '%s\t%s\t%s\t%s\n' "$ifname" "$m" "$ipv4" "$ipv6" >>"$CORAX_WORKDIR/adapters.tsv"
    done
  elif have_cmd ifconfig; then
    ifconfig 2>/dev/null | awk '
      /^[a-zA-Z0-9]/ {iface=$1; gsub(/:$/,"",iface)}
      /ether|HWaddr/ {
        for(i=1;i<=NF;i++) if($i~/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/) mac=$i
      }
      /inet / {ip=$2; gsub(/addr:/,"",ip)}
      /^$/ {
        if(iface!="" && iface!="lo" && mac!="") print iface "\t" toupper(mac) "\t" ip "\t"
        iface=""; mac=""; ip=""
      }
    ' >>"$CORAX_WORKDIR/adapters.tsv"
  fi

  # pick first non-empty MAC / IP
  if [ -s "$CORAX_WORKDIR/adapters.tsv" ]; then
    mac=$(awk -F'\t' 'NF>=2 && $2!=""{print $2; exit}' "$CORAX_WORKDIR/adapters.tsv")
    primary_ip=$(awk -F'\t' 'NF>=3 && $3!=""{print $3; exit}' "$CORAX_WORKDIR/adapters.tsv")
  fi
  # fallback: /sys
  if [ -z "$mac" ]; then
    for n in /sys/class/net/*; do
      name=$(basename "$n")
      case "$name" in lo|docker*|veth*|br-*) continue ;; esac
      if [ -r "$n/address" ]; then
        mac=$(trim "$(read_file "$n/address")" | tr 'a-f' 'A-F')
        [ -n "$mac" ] && [ "$mac" != "00:00:00:00:00:00" ] && break
      fi
    done
  fi

  write_kv mac_primary "$mac"
  write_kv primary_ip "$primary_ip"

  if [ -r /etc/resolv.conf ]; then
    awk '/^nameserver/{print $2}' /etc/resolv.conf >>"$CORAX_WORKDIR/dns.txt"
  fi
  if have_cmd resolvectl; then
    resolvectl dns 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9a-fA-F:.]+$/) print $i}' >>"$CORAX_WORKDIR/dns.txt"
  fi
}

collect_software() {
  : >"$CORAX_WORKDIR/software.tsv"
  max="${CORAX_SOFTWARE_MAX:-12000}"

  if have_cmd dpkg-query; then
    dpkg-query -W -f='${Package}\t${Version}\n' 2>/dev/null | head -n "$max" >>"$CORAX_WORKDIR/software.tsv"
  elif have_cmd rpm; then
    rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\n' 2>/dev/null | head -n "$max" >>"$CORAX_WORKDIR/software.tsv"
  elif have_cmd pacman; then
    pacman -Q 2>/dev/null | awk '{print $1 "\t" $2}' | head -n "$max" >>"$CORAX_WORKDIR/software.tsv"
  elif have_cmd apk; then
    apk info -v 2>/dev/null | sed 's/-\([0-9].*\)$/\t\1/' | head -n "$max" >>"$CORAX_WORKDIR/software.tsv"
  elif have_cmd opkg; then
    opkg list-installed 2>/dev/null | awk '{print $1 "\t" $3}' | head -n "$max" >>"$CORAX_WORKDIR/software.tsv"
  fi

  if have_cmd snap; then
    snap list 2>/dev/null | awk 'NR>1{print "snap:" $1 "\t" $2}' | head -n 200 >>"$CORAX_WORKDIR/software.tsv"
  fi
  if have_cmd flatpak; then
    flatpak list --app --columns=application,version 2>/dev/null \
      | awk -F'\t' '{print "flatpak:" $1 "\t" $2}' | head -n 200 >>"$CORAX_WORKDIR/software.tsv"
  fi
}

collect_peripherals() {
  : >"$CORAX_WORKDIR/peripherals.tsv"
  # USB devices
  if have_cmd lsusb; then
    lsusb 2>/dev/null | while IFS= read -r line; do
      name=$(printf '%s' "$line" | sed 's/^Bus [0-9]* Device [0-9]*: ID [0-9a-fA-F:]* //')
      [ -n "$name" ] && printf 'usb\t%s\n' "$name" >>"$CORAX_WORKDIR/peripherals.tsv"
    done
  elif [ -d /sys/bus/usb/devices ]; then
    for d in /sys/bus/usb/devices/*; do
      [ -r "$d/product" ] || continue
      prod=$(trim "$(read_file "$d/product")")
      [ -n "$prod" ] && printf 'usb\t%s\n' "$prod" >>"$CORAX_WORKDIR/peripherals.tsv"
    done
  fi
  # PCI network / storage as peripherals
  if have_cmd lspci; then
    lspci 2>/dev/null | awk '
      /Ethernet controller|Network controller/{sub(/^[^ ]+ /,"",$0); print "net\t"$0}
      /USB controller/{sub(/^[^ ]+ /,"",$0); print "usb\t"$0}
      /Audio device/{sub(/^[^ ]+ /,"",$0); print "audio\t"$0}
    ' >>"$CORAX_WORKDIR/peripherals.tsv"
  fi
  # input devices
  if [ -r /proc/bus/input/devices ]; then
    awk '
      /^N: Name=/{
        name=$0; sub(/^N: Name="/,"",name); sub(/"$/,"",name)
        kind="other"
        if (name ~ /[Kk]eyboard/) kind="keyboard"
        else if (name ~ /[Mm]ouse|[Tt]ouchpad/) kind="mouse"
        print kind "\t" name
      }
    ' /proc/bus/input/devices >>"$CORAX_WORKDIR/peripherals.tsv"
  fi
}

collect_sessions() {
  : >"$CORAX_WORKDIR/sessions.tsv"
  primary_user=""
  if have_cmd who; then
    who 2>/dev/null | awk '{print $1 "\t" $2 "\t" $3 " " $4 " " $5}' >>"$CORAX_WORKDIR/sessions.tsv"
    primary_user=$(who 2>/dev/null | awk '{print $1; exit}')
  fi
  if [ -z "$primary_user" ] && [ -n "$SUDO_USER" ]; then
    primary_user=$SUDO_USER
  fi
  if [ -z "$primary_user" ] && [ -n "$USER" ] && [ "$USER" != "root" ]; then
    primary_user=$USER
  fi
  write_kv primary_user "$primary_user"
  # last logins
  if have_cmd last; then
    last -n 15 2>/dev/null | head -n 15 >"$CORAX_WORKDIR/last_logins.txt" || true
  fi
}

collect_services() {
  : >"$CORAX_WORKDIR/services.tsv"
  max="${CORAX_SERVICES_MAX:-400}"
  if have_cmd systemctl; then
    systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null \
      | awk '{print $1 "\trunning"}' | head -n "$max" >>"$CORAX_WORKDIR/services.tsv"
  elif [ -d /etc/init.d ]; then
    ls /etc/init.d 2>/dev/null | head -n "$max" | awk '{print $1 "\tinit.d"}' >>"$CORAX_WORKDIR/services.tsv"
  fi
}

collect_startup() {
  : >"$CORAX_WORKDIR/startup.txt"
  if [ -r /etc/crontab ]; then
    printf '# /etc/crontab\n' >>"$CORAX_WORKDIR/startup.txt"
    head -n 40 /etc/crontab >>"$CORAX_WORKDIR/startup.txt" 2>/dev/null || true
  fi
  if [ -d /etc/cron.d ]; then
    for f in /etc/cron.d/*; do
      [ -r "$f" ] || continue
      printf '# %s\n' "$f" >>"$CORAX_WORKDIR/startup.txt"
      head -n 20 "$f" >>"$CORAX_WORKDIR/startup.txt" 2>/dev/null || true
    done
  fi
  if [ -d /etc/systemd/system ]; then
    ls /etc/systemd/system/*.service 2>/dev/null | head -n 80 >>"$CORAX_WORKDIR/startup.txt" || true
  fi
}

collect_patches() {
  : >"$CORAX_WORKDIR/patches.tsv"
  if have_cmd apt-get || have_cmd apt; then
    if have_cmd apt; then
      apt list --upgradable 2>/dev/null | awk -F/ 'NR>1{print $1 "\tupgradable"}' | head -n 500 >>"$CORAX_WORKDIR/patches.tsv"
    fi
  elif have_cmd yum; then
    yum check-update -q 2>/dev/null | awk 'NF>=2 && $1!~/^Obsoleting/{print $1 "\t" $2}' | head -n 500 >>"$CORAX_WORKDIR/patches.tsv" || true
  elif have_cmd dnf; then
    dnf check-update -q 2>/dev/null | awk 'NF>=2 && $1!~/^Obsoleting/{print $1 "\t" $2}' | head -n 500 >>"$CORAX_WORKDIR/patches.tsv" || true
  fi
}

collect_security() {
  write_kv secure_boot ""
  if [ -d /sys/firmware/efi ]; then
    write_kv firmware "UEFI"
    if [ -r /sys/firmware/efi/efivars/SecureBoot-* ] 2>/dev/null; then
      :
    fi
    if have_cmd mokutil; then
      sb=$(mokutil --sb-state 2>/dev/null | head -n 1)
      case "$sb" in
        *enabled*) write_kv secure_boot_enabled "true" ;;
        *disabled*) write_kv secure_boot_enabled "false" ;;
      esac
    fi
  else
    write_kv firmware "BIOS"
  fi
  # TPM
  if [ -c /dev/tpm0 ] || [ -c /dev/tpmrm0 ]; then
    write_kv tpm_present "true"
  else
    write_kv tpm_present "false"
  fi
  # SELinux / AppArmor
  if have_cmd getenforce; then
    write_kv selinux "$(getenforce 2>/dev/null)"
  fi
  if have_cmd aa-status; then
    write_kv apparmor "present"
  elif [ -d /sys/kernel/security/apparmor ]; then
    write_kv apparmor "present"
  fi
}

collect_virtualization() {
  virt=""
  if have_cmd systemd-detect-virt; then
    virt=$(systemd-detect-virt 2>/dev/null || true)
  fi
  if [ -z "$virt" ] || [ "$virt" = "none" ]; then
    if [ -r /sys/class/dmi/id/product_name ]; then
      pn=$(dmi_string product_name)
      case "$pn" in
        *VirtualBox*|*VMware*|*KVM*|*QEMU*|*Hyper-V*|*Xen*) virt="$pn" ;;
      esac
    fi
  fi
  write_kv virtualization "$virt"

  : >"$CORAX_WORKDIR/containers.txt"
  if have_cmd docker; then
    docker --version 2>/dev/null >>"$CORAX_WORKDIR/containers.txt" || true
    docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | head -n 50 >>"$CORAX_WORKDIR/containers.txt" || true
  fi
  if have_cmd podman; then
    podman --version 2>/dev/null >>"$CORAX_WORKDIR/containers.txt" || true
  fi
  if have_cmd lxc; then
    lxc list 2>/dev/null | head -n 20 >>"$CORAX_WORKDIR/containers.txt" || true
  fi
  if [ -r /proc/1/cgroup ] && grep -q 'docker\|lxc\|containerd\|kubepods' /proc/1/cgroup 2>/dev/null; then
    write_kv running_in_container "true"
  else
    write_kv running_in_container "false"
  fi
}

collect_battery() {
  bat=""
  for c in /sys/class/power_supply/BAT*/capacity; do
    [ -r "$c" ] || continue
    bat=$(trim "$(read_file "$c")")
    break
  done
  write_kv battery_percent "$bat"
}

run_collect_all() {
  mkdir -p "$CORAX_WORKDIR/meta"
  log "collect: hostname/os/cpu/memory/dmi..."
  collect_hostname
  collect_os
  collect_cpu
  collect_memory
  collect_dmi
  collect_gpu
  collect_disks

  if module_on storage_health; then
    log "collect: physical disks..."
    collect_physical_disks
  fi

  if module_on network; then
    log "collect: network..."
    collect_mac_and_network
  else
    # still need MAC for identity
    collect_mac_and_network
  fi

  log "collect: software packages..."
  collect_software
  collect_peripherals

  if module_on domain_sessions; then
    log "collect: sessions..."
    collect_sessions
  fi
  if module_on services; then
    log "collect: services..."
    collect_services
  fi
  if module_on startup; then
    collect_startup
  fi
  if module_on patches; then
    log "collect: pending updates..."
    collect_patches
  fi
  if module_on tpm_secureboot; then
    collect_security
  fi
  if module_on docker_wsl; then
    collect_virtualization
  fi
  if module_on battery; then
    collect_battery
  fi

  write_kv agent_version "$CORAX_AGENT_VERSION"
  write_kv collected_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)"
  write_kv profile "${CORAX_PROFILE:-full}"
}
