#include "collect.hpp"
#include "collect_extra.hpp"
#include "json_writer.hpp"
#include "util.hpp"
#include "wmi.hpp"

#include <windows.h>
#include <winreg.h>
#include <algorithm>
#include <cmath>
#include <cctype>
#include <functional>
#include <regex>
#include <set>
#include <sstream>
#include <vector>

namespace {

std::string media_type_heuristic(const std::string& model, const std::string& iface) {
  auto m = util::to_lower(model + " " + iface);
  if (m.find("nvme") != std::string::npos) return "NVMe";
  if (m.find("ssd") != std::string::npos || m.find("solid state") != std::string::npos)
    return "SSD";
  if (m.find("hdd") != std::string::npos || m.find("st[0-9]") != std::string::npos) return "HDD";
  if (m.find("usb") != std::string::npos) return "Unspecified";
  return "Unspecified";
}

void put_str(JsonWriter& j, const char* key, const std::string& v) {
  j.key(key);
  if (v.empty()) j.null_value();
  else j.value(v);
}

void collect_software(JsonWriter& j, int max_items) {
  j.key("software");
  j.begin_array();
  std::set<std::string> seen;
  const wchar_t* roots[] = {
      L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      L"SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  };
  HKEY hives[] = {HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER};
  int count = 0;
  for (HKEY hive : hives) {
    for (const wchar_t* root : roots) {
      HKEY key = nullptr;
      if (RegOpenKeyExW(hive, root, 0, KEY_READ | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS) {
        if (RegOpenKeyExW(hive, root, 0, KEY_READ, &key) != ERROR_SUCCESS) continue;
      }
      for (DWORD i = 0; count < max_items; ++i) {
        wchar_t name[256];
        DWORD nlen = 256;
        if (RegEnumKeyExW(key, i, name, &nlen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS)
          break;
        HKEY sub = nullptr;
        if (RegOpenKeyExW(key, name, 0, KEY_READ, &sub) != ERROR_SUCCESS) continue;
        wchar_t dn[512];
        DWORD typ = 0, cb = sizeof(dn);
        std::string display;
        if (RegQueryValueExW(sub, L"DisplayName", nullptr, &typ, (LPBYTE)dn, &cb) == ERROR_SUCCESS &&
            typ == REG_SZ) {
          display = util::clean_wmi(util::narrow(dn), 512);
        }
        std::string ver;
        cb = sizeof(dn);
        if (RegQueryValueExW(sub, L"DisplayVersion", nullptr, &typ, (LPBYTE)dn, &cb) ==
                ERROR_SUCCESS &&
            typ == REG_SZ) {
          ver = util::clean_wmi(util::narrow(dn), 255);
        }
        RegCloseKey(sub);
        if (display.empty()) continue;
        std::string dedupe = util::to_lower(display) + "|" + util::to_lower(ver);
        if (seen.count(dedupe)) continue;
        seen.insert(dedupe);
        j.begin_object();
        j.key("name");
        j.value(display);
        j.key("version");
        if (ver.empty()) j.null_value();
        else j.value(ver);
        j.end_object();
        ++count;
      }
      RegCloseKey(key);
    }
  }
  j.end_array();
}

std::string normalize_mac(std::string mac) {
  for (char& c : mac)
    if (c == '-') c = ':';
  for (char& c : mac) c = (char)toupper((unsigned char)c);
  return mac;
}

std::string primary_mac(WmiSession& wmi) {
  auto rows = wmi.query_cimv2(
      L"SELECT MACAddress, IPEnabled FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled=True");
  for (auto& r : rows) {
    auto mac = util::clean_wmi(r.get("MACAddress"));
    if (mac.empty()) continue;
    return normalize_mac(mac);
  }
  return {};
}

bool is_real_monitor_name(const std::string& name) {
  auto n = util::to_lower(name);
  if (n.empty()) return false;
  if (n.find("pnp") != std::string::npos) return false;
  if (n.find("generic") != std::string::npos && n.find("monitor") != std::string::npos) return false;
  if (n.find("nvidia") != std::string::npos || n.find("radeon") != std::string::npos) return false;
  if (n.find("geforce") != std::string::npos || n.find("basic display") != std::string::npos) return false;
  if (n.find("remote display") != std::string::npos || n.find("mirror") != std::string::npos) return false;
  return true;
}

bool is_noise_printer(const std::string& name) {
  auto n = util::to_lower(name);
  if (n == "microsoft print to pdf") return true;
  if (n.find("xps document writer") != std::string::npos) return true;
  if (n.find("onenote") != std::string::npos) return true;
  if (n == "fax") return true;
  return false;
}

std::string office_label(const std::string& ver) {
  if (ver == "14.0") return "Office 2010";
  if (ver == "15.0") return "Office 2013";
  if (ver == "16.0") return "Office 2016 / 365";
  if (ver.find('.') != std::string::npos && ver.size() > 4) {
    // Click-to-Run build like 16.0.xxxxx
    if (ver.rfind("16.", 0) == 0) return "Office 2016 / 365 (" + ver + ")";
    if (ver.rfind("15.", 0) == 0) return "Office 2013 (" + ver + ")";
  }
  return "Office (" + ver + ")";
}

std::string edid_monitor_name(const unsigned char* edid, size_t n) {
  if (!edid || n < 128) return {};
  // Manufacturer ID (bytes 8-9)
  char mfr[4] = {};
  unsigned b1 = edid[8], b2 = edid[9];
  mfr[0] = char(((b1 >> 2) & 0x1F) + 'A' - 1);
  mfr[1] = char((((b1 & 3) << 3) | ((b2 >> 5) & 7)) + 'A' - 1);
  mfr[2] = char((b2 & 0x1F) + 'A' - 1);
  // Descriptor blocks 54,72,90,108 — look for type 0xFC (monitor name)
  std::string model;
  for (int off : {54, 72, 90, 108}) {
    if (off + 18 > (int)n) break;
    if (edid[off] == 0 && edid[off + 1] == 0 && edid[off + 2] == 0 && edid[off + 3] == 0xFC) {
      char name[14] = {};
      for (int i = 0; i < 13; ++i) {
        unsigned char c = edid[off + 5 + i];
        if (c == 0x0A || c == 0x00) break;
        name[i] = (c >= 32 && c < 127) ? (char)c : ' ';
      }
      model = util::trim(name);
      break;
    }
  }
  std::string out = util::trim(std::string(mfr));
  if (!model.empty()) {
    if (!out.empty()) out += " ";
    out += model;
  }
  return util::clean_wmi(out, 256);
}

void collect_monitors_from_edid_registry(const std::function<void(const std::string&, const std::string&)>& add) {
  // Only currently attached monitors (registry Enum DISPLAY keeps old ghosts forever).
  DISPLAY_DEVICEW adapter{};
  adapter.cb = sizeof(adapter);
  for (DWORD ai = 0; EnumDisplayDevicesW(nullptr, ai, &adapter, 0); ++ai) {
    if (!(adapter.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP)) continue;
    DISPLAY_DEVICEW mon{};
    mon.cb = sizeof(mon);
    for (DWORD mi = 0; EnumDisplayDevicesW(adapter.DeviceName, mi, &mon, 0); ++mi) {
      if (!(mon.StateFlags & DISPLAY_DEVICE_ACTIVE) &&
          !(mon.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP))
        continue;
      std::string name = util::narrow(std::wstring(mon.DeviceString));
      std::wstring id(mon.DeviceID);
      size_t pos = id.find(L"DISPLAY\\");
      if (pos == std::wstring::npos) pos = id.find(L"MONITOR\\");
      if (pos != std::wstring::npos) {
        std::wstring rest = id.substr(pos + 8);
        size_t sep = rest.find(L'\\');
        if (sep != std::wstring::npos) {
          std::wstring mfr = rest.substr(0, sep);
          std::wstring inst = rest.substr(sep + 1);
          size_t hash = inst.find(L'#');
          if (hash != std::wstring::npos) inst = inst.substr(0, hash);
          std::wstring path =
              L"SYSTEM\\CurrentControlSet\\Enum\\DISPLAY\\" + mfr + L"\\" + inst + L"\\Device Parameters";
          HKEY dp = nullptr;
          if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.c_str(), 0, KEY_READ, &dp) == ERROR_SUCCESS) {
            BYTE edid[256];
            DWORD typ = 0, cb = sizeof(edid);
            if (RegQueryValueExW(dp, L"EDID", nullptr, &typ, edid, &cb) == ERROR_SUCCESS &&
                typ == REG_BINARY && cb >= 128) {
              auto edid_name = edid_monitor_name(edid, cb);
              if (!edid_name.empty()) name = edid_name;
            }
            RegCloseKey(dp);
          }
        }
      }
      if (!name.empty() && is_real_monitor_name(name)) add("monitor", name);
    }
  }
}

}  // namespace

std::string build_inventory_payload(const AgentConfig& cfg, const OsInfo& os) {
  WmiSession wmi;
  JsonWriter j;
  j.begin_object();

  // ---- core ----
  std::string hostname;
  {
    wchar_t buf[256];
    DWORD n = 256;
    if (GetComputerNameExW(ComputerNameDnsHostname, buf, &n)) hostname = util::narrow(buf);
    else {
      n = 256;
      GetComputerNameW(buf, &n);
      hostname = util::narrow(buf);
    }
  }

  std::string serial, mfr, model, mb_mfr, mb_prod, cpu, gpu;
  double ram_gb = 0;
  int mem_pct = 0;

  if (wmi.ok()) {
    auto bios = wmi.query_cimv2(L"SELECT SerialNumber FROM Win32_BIOS");
    if (!bios.empty()) serial = util::clean_wmi(bios[0].get("SerialNumber"));
    auto cs = wmi.query_cimv2(L"SELECT Manufacturer,Model,TotalPhysicalMemory FROM Win32_ComputerSystem");
    if (!cs.empty()) {
      mfr = util::clean_wmi(cs[0].get("Manufacturer"));
      model = util::clean_wmi(cs[0].get("Model"));
      try {
        double bytes = std::stod(cs[0].get("TotalPhysicalMemory"));
        ram_gb = std::round(bytes / (1024.0 * 1024.0 * 1024.0) * 100.0) / 100.0;
      } catch (...) {
      }
    }
    auto bb = wmi.query_cimv2(L"SELECT Manufacturer,Product FROM Win32_BaseBoard");
    if (!bb.empty()) {
      mb_mfr = util::clean_wmi(bb[0].get("Manufacturer"));
      mb_prod = util::clean_wmi(bb[0].get("Product"));
    }
    auto procs = wmi.query_cimv2(L"SELECT Name FROM Win32_Processor");
    if (!procs.empty()) cpu = util::clean_wmi(procs[0].get("Name"), 512);
    auto gpus = wmi.query_cimv2(L"SELECT Name FROM Win32_VideoController");
    for (auto& g : gpus) {
      auto n = util::clean_wmi(g.get("Name"), 256);
      if (n.empty()) continue;
      auto nl = util::to_lower(n);
      if (nl.find("basic display") != std::string::npos || nl.find("remote display") != std::string::npos)
        continue;
      gpu = n;
      break;
    }
  }

  MEMORYSTATUSEX ms{};
  ms.dwLength = sizeof(ms);
  if (GlobalMemoryStatusEx(&ms)) {
    if (ram_gb <= 0) ram_gb = std::round(ms.ullTotalPhys / (1024.0 * 1024.0 * 1024.0) * 100.0) / 100.0;
    mem_pct = (int)ms.dwMemoryLoad;
  }

  std::string os_name = os.product_name.empty() ? "Windows" : os.product_name;
  std::string os_version = os.version + " build " + std::to_string(os.build);

  j.key("hostname");
  j.value(hostname.empty() ? "unknown-host" : hostname);
  put_str(j, "serial_number", serial);
  put_str(j, "mac_primary", normalize_mac(primary_mac(wmi)));
  put_str(j, "cpu", cpu);
  j.key("ram_gb");
  j.value(ram_gb);
  put_str(j, "os_name", os_name);
  put_str(j, "os_version", os_version);
  put_str(j, "manufacturer", mfr);
  put_str(j, "model", model);
  put_str(j, "gpu_name", gpu);
  j.key("memory_used_percent");
  j.value((int64_t)mem_pct);
  put_str(j, "motherboard_manufacturer", mb_mfr);
  put_str(j, "motherboard_product", mb_prod);

  // volumes
  j.key("disks");
  j.begin_array();
  if (wmi.ok()) {
    auto vols = wmi.query_cimv2(
        L"SELECT Caption,VolumeName,Size,FreeSpace,FileSystem FROM Win32_LogicalDisk WHERE DriveType=3");
    for (auto& v : vols) {
      auto mount = util::clean_wmi(v.get("Caption"));
      if (mount.empty()) continue;
      double size = 0, free = 0;
      try {
        size = std::stod(v.get("Size"));
        free = std::stod(v.get("FreeSpace"));
      } catch (...) {
      }
      if (size <= 0) continue;
      double total_gb = std::round(size / (1024.0 * 1024.0 * 1024.0) * 100.0) / 100.0;
      double free_gb = std::round(free / (1024.0 * 1024.0 * 1024.0) * 100.0) / 100.0;
      int used = (int)std::lround(100.0 * (size - free) / size);
      j.begin_object();
      j.key("mount");
      j.value(mount);
      put_str(j, "label", util::clean_wmi(v.get("VolumeName")));
      j.key("total_gb");
      j.value(total_gb);
      j.key("used_percent");
      j.value((int64_t)used);
      j.key("free_gb");
      j.value(free_gb);
      j.end_object();
    }
  }
  j.end_array();

  collect_software(j, cfg.software_max);

  // peripherals (PnP + EDID monitors)
  j.key("peripherals");
  j.begin_array();
  std::set<std::string> seen_periph;
  auto add_periph = [&](const std::string& kind, const std::string& name) {
    if (name.empty() || kind.empty()) return;
    if (kind == "monitor" && !is_real_monitor_name(name)) return;
    if (kind == "printer" && is_noise_printer(name)) return;
    std::string key = kind + "|" + util::to_lower(name);
    if (seen_periph.count(key)) return;
    if ((int)seen_periph.size() >= 140) return;
    seen_periph.insert(key);
    j.begin_object();
    j.key("kind");
    j.value(kind);
    j.key("name");
    j.value(name);
    j.end_object();
  };

  if (wmi.ok()) {
    auto pnp = wmi.query_cimv2(
        L"SELECT Name,PNPClass FROM Win32_PnPEntity WHERE PNPClass='Keyboard' OR PNPClass='Mouse' OR "
        L"PNPClass='Monitor' OR PNPClass='Display' OR PNPClass='Camera' OR PNPClass='Image' OR "
        L"PNPClass='Media' OR PNPClass='AudioEndpoint' OR PNPClass='Printer' OR PNPClass='Bluetooth' OR "
        L"PNPClass='Biometric' OR PNPClass='Net'");
    for (auto& p : pnp) {
      auto name = util::clean_wmi(p.get("Name"), 512);
      auto cls = util::clean_wmi(p.get("PNPClass"));
      auto cl = util::to_lower(cls);
      if (name.empty() || cl.empty()) continue;
      std::string kind = cl;
      if (cl == "image" || cl == "camera") kind = "camera";
      else if (cl == "media" || cl == "audioendpoint") kind = "audio";
      else if (cl == "display" || cl == "monitor") {
        // Skip PnP DISPLAY ghosts — connected monitors come from EnumDisplayDevices+EDID.
        continue;
      }
      else if (cl == "printer" || cl == "printqueue") kind = "printer";
      else if (cl == "net") {
        auto nl = util::to_lower(name);
        if (nl.find("wan miniport") != std::string::npos || nl.find("virtual") != std::string::npos ||
            nl.find("hyper-v") != std::string::npos || nl.find("vpn") != std::string::npos ||
            nl.find("kernel debug") != std::string::npos || nl.find("wi-fi direct") != std::string::npos)
          continue;
      }
      if (util::to_lower(name).find("dameware") != std::string::npos) continue;
      add_periph(kind, name);
    }

    // EDID from registry — reliable monitor model names
    collect_monitors_from_edid_registry(add_periph);

    // WmiMonitorID fallback (when EDID parse empty)
    auto mons = wmi.query(L"ROOT\\WMI",
                          L"SELECT InstanceName FROM WmiMonitorID");
    // If still no monitors, try DesktopMonitor
    bool have_mon = false;
    for (auto& k : seen_periph) {
      if (k.rfind("monitor|", 0) == 0) {
        have_mon = true;
        break;
      }
    }
    if (!have_mon) {
      auto desk = wmi.query_cimv2(L"SELECT Name,MonitorManufacturer,MonitorType FROM Win32_DesktopMonitor");
      for (auto& m : desk) {
        auto name = util::clean_wmi(m.get("Name"), 256);
        auto mf = util::clean_wmi(m.get("MonitorManufacturer"));
        if (!mf.empty() && name.find(mf) == std::string::npos) name = mf + " " + name;
        add_periph("monitor", util::clean_wmi(name, 512));
      }
    }
    (void)mons;
  }
  j.end_array();

  // Windows print queues (shown in raw report / fleet sync tools)
  j.key("printers");
  j.begin_array();
  if (wmi.ok()) {
    auto prs = wmi.query_cimv2(
        L"SELECT Name,DriverName,PortName,Shared,Default,Network,PrinterStatus,WorkOffline FROM "
        L"Win32_Printer");
    std::set<std::string> seen_pr;
    for (auto& pr : prs) {
      auto name = util::clean_wmi(pr.get("Name"), 512);
      if (name.empty() || is_noise_printer(name)) continue;
      auto key = util::to_lower(name);
      if (seen_pr.count(key)) continue;
      seen_pr.insert(key);
      auto port = util::clean_wmi(pr.get("PortName"), 512);
      std::string ip;
      {
        // extract IPv4 from port name
        std::regex ipre(R"((\d{1,3}(?:\.\d{1,3}){3}))");
        std::smatch m;
        if (std::regex_search(port, m, ipre)) ip = m[1].str();
      }
      bool is_net = util::to_lower(pr.get("Network")) == "true" || pr.get("Network") == "1" || !ip.empty();
      int status_code = -1;
      try {
        status_code = std::stoi(pr.get("PrinterStatus"));
      } catch (...) {
      }
      bool offline = util::to_lower(pr.get("WorkOffline")) == "true" || pr.get("WorkOffline") == "1";
      std::string status_label;
      if (offline) status_label = "offline";
      else if (status_code == 3) status_label = "idle";
      else if (status_code == 4) status_label = "printing";
      else if (status_code == 7) status_label = "offline";
      else if (status_code > 0) status_label = "code_" + std::to_string(status_code);

      j.begin_object();
      j.key("name");
      j.value(name);
      put_str(j, "driver_name", util::clean_wmi(pr.get("DriverName"), 512));
      put_str(j, "port_name", port);
      j.key("shared");
      j.value(util::to_lower(pr.get("Shared")) == "true" || pr.get("Shared") == "1");
      j.key("is_default");
      j.value(util::to_lower(pr.get("Default")) == "true" || pr.get("Default") == "1");
      j.key("is_network");
      j.value(is_net);
      put_str(j, "ip_address", ip);
      j.key("status_code");
      if (status_code >= 0) j.value((int64_t)status_code);
      else j.null_value();
      put_str(j, "status_label", status_label);
      j.key("work_offline");
      j.value(offline);
      j.end_object();
    }
  }
  j.end_array();

  // ---- extended ----
  j.key("extended");
  j.begin_object();
  j.key("agent_version");
  j.value(cfg.agent_version);
  j.key("agent_family");
  j.value("cpp-v4");
  j.key("profile");
  j.value(cfg.profile);
  j.key("collected_at");
  j.value(util::iso8601_utc_now());
  j.key("os_family");
  j.value(os.family);
  j.key("os_arch");
  j.value(os.arch);
  j.key("elevated");
  j.value(util::is_elevated());
  j.key("modules_enabled");
  j.value(modules_enabled_csv(cfg.modules));

  std::vector<ModStat> mods;

  auto mark = [&](const char* name, const char* status, const std::string& detail = {}) {
    mods.push_back({name, status, detail});
  };

  // storage / physical disks (sibling of modules_result)
  if (cfg.modules.storage_health) {
    j.key("physical_disks");
    j.begin_array();
    bool got = false;
    std::string detail;
    if (os.supports_storage_api && wmi.ok()) {
      auto disks = wmi.query(L"ROOT\\Microsoft\\Windows\\Storage",
                             L"SELECT FriendlyName,MediaType,HealthStatus,Size,SerialNumber,"
                             L"BusType FROM MSFT_PhysicalDisk");
      for (auto& d : disks) {
        auto name = util::clean_wmi(d.get("FriendlyName"), 256);
        if (name.empty()) continue;
        double size = 0;
        try {
          size = std::stod(d.get("Size"));
        } catch (...) {
        }
        std::string media = util::clean_wmi(d.get("MediaType"));
        if (media == "4") media = "SSD";
        else if (media == "3") media = "HDD";
        else if (media == "5") media = "SCM";
        else if (media.empty() || media == "0") media = media_type_heuristic(name, d.get("BusType"));
        j.begin_object();
        put_str(j, "friendly_name", name);
        put_str(j, "media_type", media);
        put_str(j, "health_status", util::clean_wmi(d.get("HealthStatus")));
        j.key("size_gb");
        j.value(size > 0 ? std::round(size / (1024.0 * 1024.0 * 1024.0) * 100.0) / 100.0 : 0.0);
        put_str(j, "serial_number", util::clean_wmi(d.get("SerialNumber")));
        j.end_object();
        got = true;
      }
      if (got) detail = "MSFT_PhysicalDisk";
    }
    if (!got && wmi.ok()) {
      auto disks = wmi.query_cimv2(
          L"SELECT Model,Size,SerialNumber,InterfaceType,MediaType FROM Win32_DiskDrive");
      for (auto& d : disks) {
        auto name = util::clean_wmi(d.get("Model"), 256);
        if (name.empty()) continue;
        double size = 0;
        try {
          size = std::stod(d.get("Size"));
        } catch (...) {
        }
        auto media = util::clean_wmi(d.get("MediaType"));
        if (media.empty() || util::to_lower(media).find("fixed") != std::string::npos)
          media = media_type_heuristic(name, d.get("InterfaceType"));
        j.begin_object();
        put_str(j, "friendly_name", name);
        put_str(j, "media_type", media);
        j.key("health_status");
        j.null_value();
        j.key("size_gb");
        j.value(size > 0 ? std::round(size / (1024.0 * 1024.0 * 1024.0) * 100.0) / 100.0 : 0.0);
        put_str(j, "serial_number", util::clean_wmi(d.get("SerialNumber")));
        j.end_object();
        got = true;
      }
      detail = got ? "Win32_DiskDrive fallback" : "no disks";
    }
    j.end_array();
    mark("storage_health",
         got ? (detail.find("fallback") != std::string::npos ? "degraded" : "ok") : "degraded",
         detail);
  } else {
    mark("storage_health", "skipped");
  }

  if (cfg.modules.battery && wmi.ok()) {
    auto bats = wmi.query_cimv2(
        L"SELECT Name,Chemistry,DesignCapacity,FullChargeCapacity,EstimatedChargeRemaining,"
        L"BatteryStatus FROM Win32_Battery");
    j.key("battery");
    j.begin_array();
    for (auto& b : bats) {
      j.begin_object();
      put_str(j, "name", util::clean_wmi(b.get("Name")));
      put_str(j, "chemistry", util::clean_wmi(b.get("Chemistry")));
      auto put_i = [&](const char* k, const std::string& s) {
        j.key(k);
        try {
          j.value((int64_t)std::stoll(s));
        } catch (...) {
          j.null_value();
        }
      };
      put_i("design_capacity", b.get("DesignCapacity"));
      put_i("full_charge_capacity", b.get("FullChargeCapacity"));
      put_i("estimated_charge_remaining", b.get("EstimatedChargeRemaining"));
      put_i("battery_status", b.get("BatteryStatus"));
      j.end_object();
    }
    j.end_array();
    mark("battery", "ok", bats.empty() ? "no battery" : "");
  } else {
    mark("battery", cfg.modules.battery ? "degraded" : "skipped");
  }

  if (cfg.modules.network && wmi.ok()) {
    j.key("network");
    j.begin_object();
    j.key("adapters");
    j.begin_array();
    std::vector<std::string> gateways;
    std::vector<std::string> dns_v4;
    auto cfgs = wmi.query_cimv2(
        L"SELECT Description,MACAddress,IPAddress,DefaultIPGateway,DNSServerSearchOrder,DHCPEnabled,"
        L"IPEnabled FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled=True");
    for (auto& c : cfgs) {
      j.begin_object();
      put_str(j, "description", util::clean_wmi(c.get("Description"), 256));
      put_str(j, "mac_address", normalize_mac(util::clean_wmi(c.get("MACAddress"))));
      auto gw = util::clean_wmi(c.get("DefaultIPGateway"));
      put_str(j, "gateway", gw);
      if (!gw.empty()) gateways.push_back(gw);
      j.key("dhcp_enabled");
      j.value(util::to_lower(c.get("DHCPEnabled")) == "true" || c.get("DHCPEnabled") == "1");
      auto ips = util::clean_wmi(c.get("IPAddress"), 512);
      put_str(j, "ip_addresses", ips);
      auto dns = util::clean_wmi(c.get("DNSServerSearchOrder"), 512);
      put_str(j, "dns", dns);
      // pull IPv4-looking tokens into dns_v4
      std::regex ipre(R"((\d{1,3}(?:\.\d{1,3}){3}))");
      std::sregex_iterator it(dns.begin(), dns.end(), ipre), end;
      for (; it != end; ++it) {
        auto a = (*it)[1].str();
        if (a.rfind("127.", 0) == 0) continue;
        dns_v4.push_back(a);
      }
      j.end_object();
    }
    j.end_array();
    j.key("gateways");
    j.begin_array();
    for (auto& g : gateways) j.value(g);
    j.end_array();
    j.key("dns_v4");
    j.begin_array();
    for (auto& d : dns_v4) j.value(d);
    j.end_array();
    j.end_object();
    mark("network", "ok");
  } else {
    mark("network", cfg.modules.network ? "degraded" : "skipped");
  }

  if (cfg.modules.domain_sessions && wmi.ok()) {
    auto cs = wmi.query_cimv2(L"SELECT UserName,DomainRole,Domain,SystemType FROM Win32_ComputerSystem");
    auto osrows = wmi.query_cimv2(L"SELECT NumberOfProcesses,Locale FROM Win32_OperatingSystem");
    j.key("system");
    j.begin_object();
    if (!cs.empty()) {
      put_str(j, "primary_user", util::clean_wmi(cs[0].get("UserName")));
      put_str(j, "domain", util::clean_wmi(cs[0].get("Domain")));
      put_str(j, "computer_role", util::clean_wmi(cs[0].get("DomainRole")));
      put_str(j, "system_type", util::clean_wmi(cs[0].get("SystemType")));
    } else {
      j.key("primary_user");
      j.null_value();
    }
    if (!osrows.empty()) {
      j.key("total_processes");
      try {
        j.value((int64_t)std::stoll(osrows[0].get("NumberOfProcesses")));
      } catch (...) {
        j.null_value();
      }
      put_str(j, "locale", util::clean_wmi(osrows[0].get("Locale")));
    }
    j.end_object();
    mark("domain_sessions", "ok");
  } else {
    mark("domain_sessions", "skipped");
  }

  if (cfg.modules.patches && wmi.ok()) {
    j.key("patches");
    j.begin_array();
    auto hf = wmi.query_cimv2(L"SELECT HotFixID,Description,InstalledOn FROM Win32_QuickFixEngineering");
    int n = 0;
    for (auto it = hf.rbegin(); it != hf.rend() && n < cfg.patches_max; ++it, ++n) {
      j.begin_object();
      put_str(j, "hotfix_id", util::clean_wmi(it->get("HotFixID")));
      put_str(j, "description", util::clean_wmi(it->get("Description"), 256));
      put_str(j, "installed_on", util::clean_wmi(it->get("InstalledOn")));
      j.end_object();
    }
    j.end_array();
    mark("patches", "ok");
  } else {
    mark("patches", "skipped");
  }

  if (cfg.modules.antivirus && os.supports_security_center2 && wmi.ok()) {
    j.key("antivirus");
    j.begin_array();
    auto av = wmi.query(L"ROOT\\SecurityCenter2", L"SELECT displayName,productState FROM AntiVirusProduct");
    for (auto& a : av) {
      j.begin_object();
      put_str(j, "display_name", util::clean_wmi(a.get("displayName")));
      put_str(j, "product_state", util::clean_wmi(a.get("productState")));
      j.end_object();
    }
    j.end_array();
    mark("antivirus", av.empty() ? "degraded" : "ok");
  } else {
    mark("antivirus", cfg.modules.antivirus ? "unsupported" : "skipped",
         cfg.modules.antivirus ? "SecurityCenter2 unavailable" : "");
  }

  if (cfg.modules.bitlocker) {
    if (os.supports_bitlocker_wmi && wmi.ok()) {
      auto bl = wmi.query(L"ROOT\\CIMV2\\Security\\MicrosoftVolumeEncryption",
                          L"SELECT DriveLetter,ProtectionStatus,ConversionStatus,"
                          L"EncryptionMethod,LockStatus,IsVolumeInitializedForProtection FROM "
                          L"Win32_EncryptableVolume");
      j.key("bitlocker");
      j.begin_array();
      for (auto& b : bl) {
        auto prot = util::clean_wmi(b.get("ProtectionStatus"));
        j.begin_object();
        put_str(j, "mount_point", util::clean_wmi(b.get("DriveLetter")));
        put_str(j, "protection_status", prot);
        put_str(j, "conversion_status", util::clean_wmi(b.get("ConversionStatus")));
        put_str(j, "encryption_method", util::clean_wmi(b.get("EncryptionMethod")));
        put_str(j, "lock_status", util::clean_wmi(b.get("LockStatus")));
        put_str(j, "initialized",
                util::clean_wmi(b.get("IsVolumeInitializedForProtection")));
        // Recovery *key* is never collected — only whether volume is protected.
        j.key("protected");
        j.value(prot == "1" || util::to_lower(prot) == "true");
        j.end_object();
      }
      j.end_array();
      mark("bitlocker", "ok");
    } else {
      mark("bitlocker", "unsupported", "needs Win8+ / BitLocker WMI");
    }
  } else {
    mark("bitlocker", "skipped");
  }

  if (cfg.modules.tpm_secureboot && wmi.ok()) {
    auto tpm = wmi.query(L"ROOT\\CIMV2\\Security\\MicrosoftTpm",
                         L"SELECT IsActivated_InitialValue,IsEnabled_InitialValue,"
                         L"IsOwned_InitialValue,SpecVersion FROM Win32_Tpm");
    j.key("tpm");
    j.begin_object();
    if (!tpm.empty()) {
      j.key("present");
      j.value(true);
      put_str(j, "version", util::clean_wmi(tpm[0].get("SpecVersion")));
      j.key("enabled");
      j.value(tpm[0].get("IsEnabled_InitialValue") == "True" ||
              tpm[0].get("IsEnabled_InitialValue") == "true" ||
              tpm[0].get("IsEnabled_InitialValue") == "1");
      mark("tpm_secureboot", "ok");
    } else {
      j.key("present");
      j.value(false);
      mark("tpm_secureboot", "degraded", "TPM WMI empty");
    }
    j.end_object();
  } else {
    mark("tpm_secureboot", "skipped");
  }

  if (cfg.modules.office) {
    j.key("office_installs");
    j.begin_array();
    std::set<std::string> seen_ver;
    int office_count = 0;

    auto emit_install = [&](const std::string& ver, const std::string& label, const std::string& root) {
      if (ver.empty() && root.empty()) return;
      std::string key = ver.empty() ? ("root:" + util::to_lower(root)) : ver;
      if (seen_ver.count(key)) return;
      seen_ver.insert(key);
      j.begin_object();
      put_str(j, "version", ver);
      put_str(j, "label", label.empty() ? office_label(ver) : label);
      put_str(j, "install_root", root);
      j.end_object();
      ++office_count;
    };

    // Classic MSI Office version keys (HKLM\...\Office\16.0\...)
    const wchar_t* office_roots[] = {
        L"SOFTWARE\\Microsoft\\Office",
        L"SOFTWARE\\WOW6432Node\\Microsoft\\Office",
    };
    for (const wchar_t* root_path : office_roots) {
      HKEY root = nullptr;
      if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, root_path, 0, KEY_READ | KEY_WOW64_64KEY, &root) !=
              ERROR_SUCCESS &&
          RegOpenKeyExW(HKEY_LOCAL_MACHINE, root_path, 0, KEY_READ, &root) != ERROR_SUCCESS) {
        continue;
      }
      for (DWORD i = 0;; ++i) {
        wchar_t name[128];
        DWORD nlen = 128;
        if (RegEnumKeyExW(root, i, name, &nlen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS)
          break;
        std::string ver = util::narrow(name);
        // version keys look like 14.0 / 15.0 / 16.0
        if (ver.size() < 3 || ver.find('.') == std::string::npos) continue;
        if (!(ver[0] >= '1' && ver[0] <= '9')) continue;
        std::wstring sub = std::wstring(name) + L"\\Common\\InstallRoot";
        HKEY ir = nullptr;
        if (RegOpenKeyExW(root, sub.c_str(), 0, KEY_READ, &ir) != ERROR_SUCCESS) continue;
        wchar_t pathbuf[512];
        DWORD typ = 0, cb = sizeof(pathbuf);
        std::string path;
        if (RegQueryValueExW(ir, L"Path", nullptr, &typ, (LPBYTE)pathbuf, &cb) == ERROR_SUCCESS &&
            typ == REG_SZ) {
          path = util::narrow(pathbuf);
        }
        RegCloseKey(ir);
        if (!path.empty()) emit_install(ver, office_label(ver), path);
      }
      RegCloseKey(root);
    }

    // Click-to-Run Configuration (Microsoft 365)
    HKEY c2r = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration", 0,
                      KEY_READ | KEY_WOW64_64KEY, &c2r) == ERROR_SUCCESS) {
      wchar_t buf[512];
      DWORD typ = 0, cb = sizeof(buf);
      std::string ver, product, platform, client;
      if (RegQueryValueExW(c2r, L"VersionToReport", nullptr, &typ, (LPBYTE)buf, &cb) == ERROR_SUCCESS)
        ver = util::narrow(buf);
      cb = sizeof(buf);
      if (RegQueryValueExW(c2r, L"ProductReleaseIds", nullptr, &typ, (LPBYTE)buf, &cb) == ERROR_SUCCESS)
        product = util::narrow(buf);
      cb = sizeof(buf);
      if (RegQueryValueExW(c2r, L"Platform", nullptr, &typ, (LPBYTE)buf, &cb) == ERROR_SUCCESS)
        platform = util::narrow(buf);
      cb = sizeof(buf);
      if (RegQueryValueExW(c2r, L"ClientFolder", nullptr, &typ, (LPBYTE)buf, &cb) == ERROR_SUCCESS)
        client = util::narrow(buf);
      RegCloseKey(c2r);
      std::string label = "Microsoft 365 / Click-to-Run";
      if (!ver.empty()) label = office_label(ver.rfind("16.", 0) == 0 ? "16.0" : ver) + " - " + ver;
      if (!product.empty()) label += " [" + product + "]";
      if (!platform.empty()) label += " " + platform;
      emit_install(ver.empty() ? "16.0" : ver, label, client);
    }

    j.end_array();

    j.key("office_licenses");
    j.begin_array();
    if (wmi.ok() && office_count > 0) {
      auto lics = wmi.query_cimv2(
          L"SELECT Name,LicenseStatus,PartialProductKey FROM SoftwareLicensingProduct");
      int n = 0;
      for (auto& lic : lics) {
        if (n >= 8) break;
        auto pname = util::clean_wmi(lic.get("Name"), 512);
        auto pkey = util::clean_wmi(lic.get("PartialProductKey"));
        if (pname.empty() || pkey.empty()) continue;
        if (util::to_lower(pname).find("office") == std::string::npos) continue;
        j.begin_object();
        put_str(j, "product", pname);
        j.key("license_status");
        try {
          j.value((int64_t)std::stoll(lic.get("LicenseStatus")));
        } catch (...) {
          j.null_value();
        }
        put_str(j, "partial_key", pkey);
        j.end_object();
        ++n;
      }
    }
    j.end_array();

    mark("office", office_count > 0 ? "ok" : "degraded",
         office_count > 0 ? "" : "Office registry not found");
  } else {
    mark("office", "skipped");
  }

  if (cfg.modules.services && wmi.ok()) {
    j.key("services");
    j.begin_array();
    auto svc = wmi.query_cimv2(L"SELECT Name,DisplayName,State,StartMode FROM Win32_Service");
    int n = 0;
    for (auto& s : svc) {
      if (n >= cfg.services_max) break;
      if (util::to_lower(s.get("State")) != "running") continue;
      j.begin_object();
      put_str(j, "name", util::clean_wmi(s.get("Name")));
      put_str(j, "display_name", util::clean_wmi(s.get("DisplayName"), 256));
      put_str(j, "status", util::clean_wmi(s.get("State")));
      put_str(j, "start_type", util::clean_wmi(s.get("StartMode")));
      j.end_object();
      ++n;
    }
    j.end_array();
    mark("services", "ok");
  } else {
    mark("services", "skipped");
  }

  if (cfg.modules.docker_wsl) {
    if (os.family == "win10" || os.family == "win11" || os.family == "server") {
      j.key("virtual");
      j.begin_object();
      j.key("wsl");
      j.value(GetFileAttributesW(L"C:\\Windows\\System32\\wsl.exe") != INVALID_FILE_ATTRIBUTES);
      j.key("docker_desktop");
      j.value(GetFileAttributesW(L"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe") !=
              INVALID_FILE_ATTRIBUTES);
      j.end_object();
      mark("docker_wsl", "ok");
    } else {
      mark("docker_wsl", "unsupported", "Win10+ only");
    }
  } else {
    mark("docker_wsl", "skipped");
  }

  mark("startup", "skipped", "reserved");
  mark("windows_features", "skipped", "reserved");

  collect_extended_extras(j, wmi, cfg, os, mods);

  j.key("modules_result");
  j.begin_object();
  for (const auto& m : mods) {
    j.key(m.name);
    j.begin_object();
    j.key("status");
    j.value(m.status);
    if (!m.detail.empty()) {
      j.key("detail");
      j.value(m.detail);
    }
    j.end_object();
  }
  j.end_object();

  j.end_object();  // extended
  j.end_object();  // root
  return j.str();
}
