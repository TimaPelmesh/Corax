#include "wmi.hpp"
#include "util.hpp"

#define _WIN32_DCOM
#include <windows.h>
#include <comdef.h>
#include <Wbemidl.h>
#include <exception>
#pragma comment(lib, "wbemuuid.lib")

namespace {
// Real WMI query body. Split out so `WmiSession::query` can wrap it in a
// try/catch: with the process-wide `_set_se_translator` (crash_handler.cpp)
// this also catches WMI provider access violations, which happen in the
// wild for BitLocker / SecurityCenter2 / MSFT_PhysicalDisk on some builds.
std::vector<WmiRowMap> query_impl(bool ready, const std::wstring& ns, const std::wstring& wql);

// WmiMonitorID names arrive as a short array of character codes, not a string.
std::string variant_array_text(const VARIANT& vt) {
  if ((vt.vt & VT_ARRAY) == 0 || vt.parray == nullptr) return {};
  const VARTYPE elem = static_cast<VARTYPE>(vt.vt & ~VT_ARRAY & ~VT_BYREF);
  if (elem != VT_UI1 && elem != VT_UI2 && elem != VT_I2 && elem != VT_I4) return {};
  if (SafeArrayGetDim(vt.parray) != 1) return {};
  LONG lb = 0;
  LONG ub = -1;
  if (FAILED(SafeArrayGetLBound(vt.parray, 1, &lb)) || FAILED(SafeArrayGetUBound(vt.parray, 1, &ub))) return {};
  if (ub < lb || (ub - lb) > 80) return {};
  std::string out;
  out.reserve(static_cast<size_t>(ub - lb + 1));
  for (LONG i = lb; i <= ub; ++i) {
    long value = 0;
    if (elem == VT_UI1) {
      unsigned char c = 0;
      if (FAILED(SafeArrayGetElement(vt.parray, &i, &c))) return {};
      value = c;
    } else if (elem == VT_UI2 || elem == VT_I2) {
      unsigned short c = 0;
      if (FAILED(SafeArrayGetElement(vt.parray, &i, &c))) return {};
      value = c;
    } else {
      LONG c = 0;
      if (FAILED(SafeArrayGetElement(vt.parray, &i, &c))) return {};
      value = c;
    }
    if (value == 0) break;
    if (value < 32 || value > 126) return {};
    out.push_back(static_cast<char>(value));
  }
  return util::trim(out);
}
}  // namespace

WmiSession::WmiSession() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) return;
  hr = CoInitializeSecurity(nullptr, -1, nullptr, nullptr, RPC_C_AUTHN_LEVEL_DEFAULT,
                            RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE, nullptr);
  if (FAILED(hr) && hr != RPC_E_TOO_LATE) {
    // continue — often already initialized by host
  }
  ready_ = true;
}

WmiSession::~WmiSession() {
  // Do not CoUninitialize here — other threads/modules may still need COM.
}

std::vector<WmiRowMap> WmiSession::query(const std::wstring& ns, const std::wstring& wql) {
  try {
    return query_impl(ready_, ns, wql);
  } catch (const std::exception&) {
    // Translated SEH from a WMI provider (ACCESS_VIOLATION etc.) or an OOM
    // on a giant result set. Either way — return empty so the caller can
    // fall back or degrade the module instead of taking down the process.
    return {};
  } catch (...) {
    return {};
  }
}

namespace {
std::vector<WmiRowMap> query_impl(bool ready, const std::wstring& ns, const std::wstring& wql) {
  std::vector<WmiRowMap> out;
  if (!ready) return out;

  IWbemLocator* locator = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER, IID_IWbemLocator,
                                (LPVOID*)&locator);
  if (FAILED(hr) || !locator) return out;

  IWbemServices* services = nullptr;
  hr = locator->ConnectServer(_bstr_t(ns.c_str()), nullptr, nullptr, nullptr, 0, nullptr, nullptr,
                              &services);
  if (FAILED(hr) || !services) {
    locator->Release();
    return out;
  }

  CoSetProxyBlanket(services, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr,
                    RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE);

  IEnumWbemClassObject* enumerator = nullptr;
  hr = services->ExecQuery(bstr_t(L"WQL"), bstr_t(wql.c_str()),
                           WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, nullptr,
                           &enumerator);
  if (FAILED(hr) || !enumerator) {
    services->Release();
    locator->Release();
    return out;
  }

  IWbemClassObject* obj = nullptr;
  ULONG returned = 0;
  // Never wait forever: a stuck WMI provider used to freeze/kill the agent
  // after the splash with a desktop shortcut already written.
  constexpr ULONG kNextTimeoutMs = 8000;
  constexpr ULONGLONG kQueryBudgetMs = 20000;
  constexpr size_t kMaxRows = 3000;
  const ULONGLONG t0 = GetTickCount64();
  while (out.size() < kMaxRows) {
    if (GetTickCount64() - t0 > kQueryBudgetMs) break;
    HRESULT nhr = enumerator->Next(kNextTimeoutMs, 1, &obj, &returned);
    if (nhr != S_OK || !returned || !obj) break;
    WmiRowMap row;
    SAFEARRAY* names = nullptr;
    if (SUCCEEDED(obj->GetNames(nullptr, WBEM_FLAG_ALWAYS | WBEM_FLAG_NONSYSTEM_ONLY, nullptr,
                                &names)) &&
        names) {
      LONG lbound = 0, ubound = 0;
      SafeArrayGetLBound(names, 1, &lbound);
      SafeArrayGetUBound(names, 1, &ubound);
      for (LONG i = lbound; i <= ubound; ++i) {
        BSTR name = nullptr;
        if (FAILED(SafeArrayGetElement(names, &i, &name)) || !name) continue;
        VARIANT vt;
        VariantInit(&vt);
        if (SUCCEEDED(obj->Get(name, 0, &vt, nullptr, nullptr))) {
          std::string key = util::narrow(name);
          if (vt.vt == VT_NULL || vt.vt == VT_EMPTY) {
            // skip
          } else if (vt.vt == VT_BSTR && vt.bstrVal) {
            row.fields[key] = util::narrow(vt.bstrVal);
          } else if (vt.vt & VT_ARRAY) {
            auto text = variant_array_text(vt);
            if (!text.empty()) row.fields[key] = std::move(text);
          } else {
            VARIANT str;
            VariantInit(&str);
            if (SUCCEEDED(VariantChangeType(&str, &vt, 0, VT_BSTR)) && str.bstrVal) {
              row.fields[key] = util::narrow(str.bstrVal);
            }
            VariantClear(&str);
          }
        }
        VariantClear(&vt);
        SysFreeString(name);
      }
      SafeArrayDestroy(names);
    }
    out.push_back(std::move(row));
    obj->Release();
    obj = nullptr;
  }

  enumerator->Release();
  services->Release();
  locator->Release();
  return out;
}
}  // namespace
