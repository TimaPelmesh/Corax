#include "wmi.hpp"
#include "util.hpp"

#define _WIN32_DCOM
#include <windows.h>
#include <comdef.h>
#include <Wbemidl.h>
#pragma comment(lib, "wbemuuid.lib")

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
  std::vector<WmiRowMap> out;
  if (!ready_) return out;

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
  while (enumerator->Next(WBEM_INFINITE, 1, &obj, &returned) == S_OK) {
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
