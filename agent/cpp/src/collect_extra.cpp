#include "collect_extra.hpp"
#include "util.hpp"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <lm.h>

#include <algorithm>
#include <cmath>
#include <set>
#include <string>
#include <vector>

#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "netapi32.lib")

namespace {

void put_str(JsonWriter& j, const char* key, const std::string& v) {
  j.key(key);
  if (v.empty()) j.null_value();
  else j.value(v);
}

void mark(std::vector<ModStat>& mods, const char* name, const char* status,
          const std::string& detail = {}) {
  mods.push_back({name, status, detail});
}

bool reg_key_exists(HKEY root, const wchar_t* path) {
  HKEY k = nullptr;
  if (RegOpenKeyExW(root, path, 0, KEY_READ, &k) != ERROR_SUCCESS) return false;
  RegCloseKey(k);
  return true;
}

DWORD reg_dword(HKEY root, const wchar_t* path, const wchar_t* name, DWORD def = 0) {
  HKEY k = nullptr;
  if (RegOpenKeyExW(root, path, 0, KEY_READ, &k) != ERROR_SUCCESS) return def;
  DWORD val = def, typ = 0, cb = sizeof(val);
  if (RegQueryValueExW(k, name, nullptr, &typ, (LPBYTE)&val, &cb) != ERROR_SUCCESS || typ != REG_DWORD)
    val = def;
  RegCloseKey(k);
  return val;
}

std::string wide_to_utf8(const wchar_t* w) {
  if (!w || !w[0]) return {};
  return util::narrow(std::wstring(w));
}

std::string read_reg_sz(HKEY root, const wchar_t* path, const wchar_t* name) {
  HKEY k = nullptr;
  if (RegOpenKeyExW(root, path, 0, KEY_READ, &k) != ERROR_SUCCESS) return {};
  wchar_t buf[512];
  DWORD typ = 0, cb = sizeof(buf);
  std::string out;
  if (RegQueryValueExW(k, name, nullptr, &typ, (LPBYTE)buf, &cb) == ERROR_SUCCESS && typ == REG_SZ)
    out = util::narrow(std::wstring(buf));
  RegCloseKey(k);
  return out;
}

}  // namespace

void collect_extended_extras(JsonWriter& j, WmiSession& wmi, const AgentConfig& cfg, const OsInfo& os,
                             std::vector<ModStat>& mods) {
  // ---- GPUs: name, driver, VRAM ----
  if (wmi.ok()) {
    j.key("gpus");
    j.begin_array();
    auto gpus = wmi.query_cimv2(
        L"SELECT Name,DriverVersion,DriverDate,AdapterRAM,PNPDeviceID,VideoProcessor FROM "
        L"Win32_VideoController");
    int n = 0;
    for (auto& g : gpus) {
      auto name = util::clean_wmi(g.get("Name"), 256);
      if (name.empty()) continue;
      auto nl = util::to_lower(name);
      if (nl.find("basic display") != std::string::npos || nl.find("remote display") != std::string::npos)
        continue;
      double vram_gb = 0;
      try {
        double bytes = std::stod(g.get("AdapterRAM"));
        if (bytes > 0) vram_gb = std::round(bytes / (1024.0 * 1024.0 * 1024.0) * 100.0) / 100.0;
      } catch (...) {
      }
      j.begin_object();
      put_str(j, "name", name);
      put_str(j, "driver_version", util::clean_wmi(g.get("DriverVersion")));
      put_str(j, "driver_date", util::clean_wmi(g.get("DriverDate")));
      put_str(j, "video_processor", util::clean_wmi(g.get("VideoProcessor"), 256));
      j.key("vram_gb");
      if (vram_gb > 0) j.value(vram_gb);
      else j.null_value();
      j.end_object();
      ++n;
    }
    j.end_array();
    mark(mods, "gpus", n > 0 ? "ok" : "degraded");
  }

  // ---- Secure Boot ----
  {
    DWORD sb = reg_dword(HKEY_LOCAL_MACHINE,
                         L"SYSTEM\\CurrentControlSet\\Control\\SecureBoot\\State",
                         L"UEFISecureBootEnabled", 0xFFFFFFFF);
    j.key("secure_boot_enabled");
    if (sb == 0xFFFFFFFF) j.null_value();
    else j.value(sb != 0);
    mark(mods, "secure_boot", sb == 0xFFFFFFFF ? "unsupported" : "ok");
  }

  // ---- Pending reboot + last patch date ----
  {
    bool pending =
        reg_key_exists(HKEY_LOCAL_MACHINE,
                       L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\"
                       L"RebootRequired") ||
        reg_key_exists(HKEY_LOCAL_MACHINE,
                       L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\"
                       L"RebootPending") ||
        reg_key_exists(HKEY_LOCAL_MACHINE,
                       L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\"
                       L"RebootInProgress");
    HKEY sm = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Control\\Session Manager", 0,
                      KEY_READ, &sm) == ERROR_SUCCESS) {
      DWORD typ = 0, cb = 0;
      if (RegQueryValueExW(sm, L"PendingFileRenameOperations", nullptr, &typ, nullptr, &cb) ==
              ERROR_SUCCESS &&
          cb > 2)
        pending = true;
      RegCloseKey(sm);
    }
    j.key("pending_reboot");
    j.value(pending);

    std::string last_id;
    std::string last_on;
    if (wmi.ok()) {
      auto hf = wmi.query_cimv2(L"SELECT HotFixID,InstalledOn FROM Win32_QuickFixEngineering");
      for (auto& r : hf) {
        auto on = util::clean_wmi(r.get("InstalledOn"));
        auto id = util::clean_wmi(r.get("HotFixID"));
        if (on.empty()) continue;
        if (on >= last_on) {
          last_on = on;
          last_id = id;
        }
      }
    }
    put_str(j, "last_hotfix_id", last_id);
    put_str(j, "last_hotfix_on", last_on);
    mark(mods, "pending_reboot", "ok", pending ? "reboot pending" : "");
  }

  // ---- Local Administrators (localized group via well-known SID) ----
  {
    j.key("local_admins");
    j.begin_array();
    int n = 0;
    NET_API_STATUS st = NERR_Success;
    std::wstring group_name = L"Administrators";
    PSID sid = nullptr;
    SID_IDENTIFIER_AUTHORITY nt_auth = SECURITY_NT_AUTHORITY;
    if (AllocateAndInitializeSid(&nt_auth, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS, 0,
                                 0, 0, 0, 0, 0, &sid)) {
      wchar_t name[256], domain[256];
      DWORD nlen = 256, dlen = 256;
      SID_NAME_USE use = SidTypeUnknown;
      if (LookupAccountSidW(nullptr, sid, name, &nlen, domain, &dlen, &use))
        group_name = name;
      FreeSid(sid);
    }
    DWORD entries = 0, total = 0;
    LOCALGROUP_MEMBERS_INFO_3* info = nullptr;
    st = NetLocalGroupGetMembers(nullptr, group_name.c_str(), 3, (LPBYTE*)&info, MAX_PREFERRED_LENGTH,
                                 &entries, &total, nullptr);
    if (st == NERR_Success && info) {
      for (DWORD i = 0; i < entries && n < 64; ++i) {
        auto name = wide_to_utf8(info[i].lgrmi3_domainandname);
        if (name.empty()) continue;
        j.value(name);
        ++n;
      }
      NetApiBufferFree(info);
    }
    j.end_array();
    mark(mods, "local_admins", n > 0 ? "ok" : "degraded",
         n > 0 ? "" : ("netapi " + std::to_string(st)));
  }

  // ---- Mapped network drives (session + per-user Network keys) ----
  {
    j.key("mapped_drives");
    j.begin_array();
    int n = 0;
    if (wmi.ok()) {
      auto maps = wmi.query_cimv2(
          L"SELECT LocalName,RemoteName,ProviderName,ConnectionState FROM Win32_NetworkConnection");
      for (auto& m : maps) {
        auto local = util::clean_wmi(m.get("LocalName"));
        auto remote = util::clean_wmi(m.get("RemoteName"), 512);
        if (local.empty() && remote.empty()) continue;
        j.begin_object();
        put_str(j, "local_name", local);
        put_str(j, "remote_path", remote);
        put_str(j, "provider", util::clean_wmi(m.get("ProviderName")));
        put_str(j, "state", util::clean_wmi(m.get("ConnectionState")));
        put_str(j, "scope", std::string("session"));
        j.end_object();
        ++n;
      }
      auto nets = wmi.query_cimv2(
          L"SELECT DeviceID,ProviderName,VolumeName FROM Win32_LogicalDisk WHERE DriveType=4");
      for (auto& m : nets) {
        auto local = util::clean_wmi(m.get("DeviceID"));
        auto remote = util::clean_wmi(m.get("ProviderName"), 512);
        if (local.empty()) continue;
        j.begin_object();
        put_str(j, "local_name", local);
        put_str(j, "remote_path", remote);
        put_str(j, "label", util::clean_wmi(m.get("VolumeName")));
        put_str(j, "scope", std::string("logical"));
        j.end_object();
        ++n;
      }
    }
    HKEY hku = nullptr;
    if (RegOpenKeyExW(HKEY_USERS, nullptr, 0, KEY_READ, &hku) == ERROR_SUCCESS) {
      for (DWORD i = 0; n < 120; ++i) {
        wchar_t sid[256];
        DWORD slen = 256;
        if (RegEnumKeyExW(hku, i, sid, &slen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS)
          break;
        std::wstring sid_s(sid);
        if (sid_s.find(L"_Classes") != std::wstring::npos || sid_s == L".DEFAULT") continue;
        HKEY net = nullptr;
        std::wstring net_path = sid_s + L"\\Network";
        if (RegOpenKeyExW(hku, net_path.c_str(), 0, KEY_READ, &net) != ERROR_SUCCESS) continue;
        for (DWORD d = 0; n < 120; ++d) {
          wchar_t letter[64];
          DWORD llen = 64;
          if (RegEnumKeyExW(net, d, letter, &llen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS)
            break;
          HKEY drive = nullptr;
          if (RegOpenKeyExW(net, letter, 0, KEY_READ, &drive) != ERROR_SUCCESS) continue;
          wchar_t remote[512];
          DWORD typ = 0, cb = sizeof(remote);
          std::string remote_path;
          if (RegQueryValueExW(drive, L"RemotePath", nullptr, &typ, (LPBYTE)remote, &cb) ==
                  ERROR_SUCCESS &&
              typ == REG_SZ)
            remote_path = util::narrow(std::wstring(remote));
          RegCloseKey(drive);
          j.begin_object();
          put_str(j, "local_name", util::narrow(std::wstring(letter)) + ":");
          put_str(j, "remote_path", remote_path);
          put_str(j, "user_sid", util::narrow(sid_s));
          put_str(j, "scope", std::string("user"));
          j.end_object();
          ++n;
        }
        RegCloseKey(net);
      }
      RegCloseKey(hku);
    }
    j.end_array();
    mark(mods, "mapped_drives", "ok");
  }

  // ---- Per-user printer connections (HKU) ----
  {
    j.key("user_printers");
    j.begin_array();
    int n = 0;
    HKEY hku = nullptr;
    if (RegOpenKeyExW(HKEY_USERS, nullptr, 0, KEY_READ, &hku) == ERROR_SUCCESS) {
      for (DWORD i = 0; n < 100; ++i) {
        wchar_t sid[256];
        DWORD slen = 256;
        if (RegEnumKeyExW(hku, i, sid, &slen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS)
          break;
        std::wstring sid_s(sid);
        if (sid_s.find(L"_Classes") != std::wstring::npos || sid_s == L".DEFAULT") continue;
        HKEY conn = nullptr;
        std::wstring path = sid_s + L"\\Printers\\Connections";
        if (RegOpenKeyExW(hku, path.c_str(), 0, KEY_READ, &conn) != ERROR_SUCCESS) continue;
        for (DWORD p = 0; n < 100; ++p) {
          wchar_t pname[512];
          DWORD plen = 512;
          if (RegEnumKeyExW(conn, p, pname, &plen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS)
            break;
          std::string raw = util::narrow(std::wstring(pname));
          for (char& c : raw)
            if (c == ',') c = '\\';
          j.begin_object();
          put_str(j, "connection", raw);
          put_str(j, "user_sid", util::narrow(sid_s));
          j.end_object();
          ++n;
        }
        RegCloseKey(conn);
      }
      RegCloseKey(hku);
    }
    j.end_array();
    mark(mods, "user_printers", "ok");
  }

  // ---- Battery health (wear) ----
  if (cfg.modules.battery && wmi.ok()) {
    auto bats = wmi.query_cimv2(
        L"SELECT Name,DesignCapacity,FullChargeCapacity,EstimatedChargeRemaining FROM Win32_Battery");
    if (!bats.empty()) {
      auto& b = bats[0];
      double design = 0, full = 0;
      try {
        design = std::stod(b.get("DesignCapacity"));
        full = std::stod(b.get("FullChargeCapacity"));
      } catch (...) {
      }
      j.key("battery_health");
      j.begin_object();
      put_str(j, "name", util::clean_wmi(b.get("Name")));
      j.key("design_capacity");
      j.value((int64_t)design);
      j.key("full_charge_capacity");
      j.value((int64_t)full);
      j.key("health_percent");
      if (design > 0 && full > 0)
        j.value((int64_t)std::lround(100.0 * full / design));
      else
        j.null_value();
      j.key("charge_remaining_percent");
      try {
        j.value((int64_t)std::stoll(b.get("EstimatedChargeRemaining")));
      } catch (...) {
        j.null_value();
      }
      j.end_object();
      mark(mods, "battery_health", "ok");
    } else {
      mark(mods, "battery_health", "ok", "no battery");
    }
  }

  // ---- USB history (USBSTOR) ----
  if (cfg.modules.usb_history) {
    j.key("usb_history");
    j.begin_array();
    HKEY usb = nullptr;
    int n = 0;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Enum\\USBSTOR", 0, KEY_READ,
                      &usb) == ERROR_SUCCESS) {
      for (DWORD i = 0; n < 200; ++i) {
        wchar_t device[256];
        DWORD dlen = 256;
        if (RegEnumKeyExW(usb, i, device, &dlen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS)
          break;
        HKEY dev = nullptr;
        if (RegOpenKeyExW(usb, device, 0, KEY_READ, &dev) != ERROR_SUCCESS) continue;
        for (DWORD jj = 0; n < 200; ++jj) {
          wchar_t inst[256];
          DWORD ilen = 256;
          if (RegEnumKeyExW(dev, jj, inst, &ilen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS)
            break;
          HKEY ik = nullptr;
          if (RegOpenKeyExW(dev, inst, 0, KEY_READ, &ik) != ERROR_SUCCESS) continue;
          wchar_t friendly[512];
          DWORD typ = 0, cb = sizeof(friendly);
          std::string fname;
          if (RegQueryValueExW(ik, L"FriendlyName", nullptr, &typ, (LPBYTE)friendly, &cb) ==
                  ERROR_SUCCESS &&
              typ == REG_SZ)
            fname = util::narrow(std::wstring(friendly));
          RegCloseKey(ik);
          j.begin_object();
          put_str(j, "device", util::narrow(std::wstring(device)));
          put_str(j, "instance", util::narrow(std::wstring(inst)));
          put_str(j, "friendly_name", util::clean_wmi(fname, 512));
          j.end_object();
          ++n;
        }
        RegCloseKey(dev);
      }
      RegCloseKey(usb);
    }
    j.end_array();
    mark(mods, "usb_history", "ok");
  } else {
    mark(mods, "usb_history", "skipped");
  }

  // ---- Listening TCP ports (top-N unique) ----
  {
    j.key("listening_ports");
    j.begin_array();
    DWORD size = 0;
    GetExtendedTcpTable(nullptr, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
    int n = 0;
    if (size > 0) {
      std::vector<char> buf(size);
      if (GetExtendedTcpTable(buf.data(), &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) ==
          NO_ERROR) {
        auto* table = reinterpret_cast<MIB_TCPTABLE_OWNER_PID*>(buf.data());
        std::set<uint16_t> seen;
        for (DWORD i = 0; i < table->dwNumEntries && n < 40; ++i) {
          auto& row = table->table[i];
          uint16_t port = ntohs((u_short)row.dwLocalPort);
          if (!seen.insert(port).second) continue;
          j.begin_object();
          j.key("port");
          j.value((int64_t)port);
          j.key("pid");
          j.value((int64_t)row.dwOwningPid);
          j.key("proto");
          j.value("tcp");
          j.end_object();
          ++n;
        }
      }
    }
    j.end_array();
    mark(mods, "listening_ports", "ok");
  }

  // ---- Runtimes: .NET + VC++ redistributables ----
  {
    j.key("runtimes");
    j.begin_array();
    const wchar_t* roots[] = {
        L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        L"SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    };
    std::set<std::string> seen;
    int n = 0;
    for (auto* root_path : roots) {
      HKEY root = nullptr;
      if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, root_path, 0, KEY_READ, &root) != ERROR_SUCCESS) continue;
      for (DWORD i = 0; n < 80; ++i) {
        wchar_t name[256];
        DWORD nlen = 256;
        if (RegEnumKeyExW(root, i, name, &nlen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS)
          break;
        HKEY sub = nullptr;
        if (RegOpenKeyExW(root, name, 0, KEY_READ, &sub) != ERROR_SUCCESS) continue;
        wchar_t dn[512];
        DWORD typ = 0, cb = sizeof(dn);
        std::string display, ver;
        if (RegQueryValueExW(sub, L"DisplayName", nullptr, &typ, (LPBYTE)dn, &cb) == ERROR_SUCCESS &&
            typ == REG_SZ)
          display = util::narrow(std::wstring(dn));
        cb = sizeof(dn);
        if (RegQueryValueExW(sub, L"DisplayVersion", nullptr, &typ, (LPBYTE)dn, &cb) == ERROR_SUCCESS &&
            typ == REG_SZ)
          ver = util::narrow(std::wstring(dn));
        RegCloseKey(sub);
        auto dl = util::to_lower(display);
        bool keep = false;
        std::string kind;
        if (dl.find("microsoft .net") != std::string::npos ||
            dl.find("microsoft.net") != std::string::npos) {
          keep = true;
          kind = "dotnet";
        } else if (dl.find("visual c++") != std::string::npos ||
                   dl.find("microsoft visual c++") != std::string::npos) {
          keep = true;
          kind = "vcredist";
        }
        if (!keep || display.empty()) continue;
        std::string key = util::to_lower(display) + "|" + util::to_lower(ver);
        if (!seen.insert(key).second) continue;
        j.begin_object();
        put_str(j, "kind", kind);
        put_str(j, "name", util::clean_wmi(display, 512));
        put_str(j, "version", util::clean_wmi(ver, 128));
        j.end_object();
        ++n;
      }
      RegCloseKey(root);
    }
    j.end_array();
    mark(mods, "runtimes", "ok");
  }

  // ---- Browser summary ----
  {
    j.key("browsers");
    j.begin_array();
    struct BrowserHint {
      const char* name;
      const wchar_t* path;
      const wchar_t* ver_value;
    };
    const BrowserHint hints[] = {
        {"Microsoft Edge", L"SOFTWARE\\Microsoft\\Edge\\BLBeacon", L"version"},
        {"Google Chrome", L"SOFTWARE\\Google\\Chrome\\BLBeacon", L"version"},
        {"Mozilla Firefox", L"SOFTWARE\\Mozilla\\Mozilla Firefox", L"CurrentVersion"},
    };
    int n = 0;
    for (const auto& h : hints) {
      auto ver = read_reg_sz(HKEY_LOCAL_MACHINE, h.path, h.ver_value);
      if (ver.empty()) ver = read_reg_sz(HKEY_CURRENT_USER, h.path, h.ver_value);
      if (ver.empty() && std::string(h.name) == "Google Chrome") {
        ver = read_reg_sz(HKEY_LOCAL_MACHINE,
                          L"SOFTWARE\\WOW6432Node\\Google\\Chrome\\BLBeacon", L"version");
      }
      if (ver.empty() && std::string(h.name) == "Mozilla Firefox") {
        HKEY fx = nullptr;
        if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Mozilla\\Mozilla Firefox", 0, KEY_READ,
                          &fx) == ERROR_SUCCESS) {
          wchar_t sub[128];
          DWORD slen = 128;
          if (RegEnumKeyExW(fx, 0, sub, &slen, nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS)
            ver = util::narrow(std::wstring(sub));
          RegCloseKey(fx);
        }
      }
      if (ver.empty()) continue;
      j.begin_object();
      put_str(j, "name", std::string(h.name));
      put_str(j, "version", util::clean_wmi(ver, 128));
      j.end_object();
      ++n;
    }
    j.end_array();
    mark(mods, "browsers", n > 0 ? "ok" : "degraded");
  }

  // ---- Disk SMART / health summary ----
  if (cfg.modules.storage_health && wmi.ok()) {
    j.key("disk_health");
    j.begin_array();
    auto disks = wmi.query_cimv2(
        L"SELECT Model,Status,Size,SerialNumber,InterfaceType FROM Win32_DiskDrive");
    for (auto& d : disks) {
      auto model = util::clean_wmi(d.get("Model"), 256);
      if (model.empty()) continue;
      j.begin_object();
      put_str(j, "model", model);
      put_str(j, "status", util::clean_wmi(d.get("Status")));
      put_str(j, "serial_number", util::clean_wmi(d.get("SerialNumber")));
      put_str(j, "interface", util::clean_wmi(d.get("InterfaceType")));
      j.end_object();
    }
    if (os.supports_storage_api) {
      auto pd = wmi.query(L"ROOT\\Microsoft\\Windows\\Storage",
                          L"SELECT FriendlyName,HealthStatus,OperationalStatus,SerialNumber FROM "
                          L"MSFT_PhysicalDisk");
      for (auto& d : pd) {
        j.begin_object();
        put_str(j, "model", util::clean_wmi(d.get("FriendlyName"), 256));
        put_str(j, "health_status", util::clean_wmi(d.get("HealthStatus")));
        put_str(j, "operational_status", util::clean_wmi(d.get("OperationalStatus")));
        put_str(j, "serial_number", util::clean_wmi(d.get("SerialNumber")));
        put_str(j, "source", std::string("MSFT_PhysicalDisk"));
        j.end_object();
      }
    }
    j.end_array();
    mark(mods, "disk_health", "ok");
  }
}
