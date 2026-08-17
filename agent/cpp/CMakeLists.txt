cmake_minimum_required(VERSION 3.16)
project(corax_agent_cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_VS_WINDOWS_TARGET_PLATFORM_MIN_VERSION "6.1")

set(CORAX_ICON "${CMAKE_CURRENT_SOURCE_DIR}/assets/corax-agent.ico")
if(WIN32)
  find_program(CORAX_POWERSHELL NAMES pwsh powershell REQUIRED)
  add_custom_command(
    OUTPUT "${CORAX_ICON}"
    COMMAND "${CORAX_POWERSHELL}" -NoProfile -ExecutionPolicy Bypass
            -File "${CMAKE_CURRENT_SOURCE_DIR}/scripts/New-CoraxAgentIcon.ps1"
            -OutputPath "${CORAX_ICON}"
    DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/scripts/New-CoraxAgentIcon.ps1"
    COMMENT "Generating CORAX multi-resolution Windows icon"
    VERBATIM
  )
  add_custom_target(CORAX-Agent-Assets DEPENDS "${CORAX_ICON}")
endif()

add_executable(CORAX-Agent
  src/main.cpp
  src/config.cpp
  src/secure_config.cpp
  src/osdetect.cpp
  src/wmi.cpp
  src/http.cpp
  src/json_writer.cpp
  src/util.cpp
  src/collect.cpp
  src/collect_extra.cpp
  src/ui_splash.cpp
  resources/CORAX-Agent.rc
)

target_include_directories(CORAX-Agent PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)

if(MSVC)
  add_dependencies(CORAX-Agent CORAX-Agent-Assets)
  set_property(
    TARGET CORAX-Agent
    PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
  target_compile_definitions(CORAX-Agent PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _CRT_SECURE_NO_WARNINGS
    _WIN32_WINNT=0x0601
    WINVER=0x0601
    NTDDI_VERSION=0x06010000
  )
  target_compile_options(CORAX-Agent PRIVATE /W3 /EHsc /utf-8)
  target_link_libraries(CORAX-Agent PRIVATE
    ole32
    oleaut32
    wbemuuid
    winhttp
    iphlpapi
    ws2_32
    netapi32
    advapi32
    crypt32
    shell32
    version
    comctl32
    gdi32
    user32
  )
  set_target_properties(CORAX-Agent PROPERTIES WIN32_EXECUTABLE TRUE)
  # Keep int main() entry while using WINDOWS subsystem (no black console).
  target_link_options(
    CORAX-Agent PRIVATE
    "/ENTRY:mainCRTStartup"
    "/MANIFEST:NO"
    "/SUBSYSTEM:WINDOWS,6.01"
  )
endif()

install(TARGETS CORAX-Agent RUNTIME DESTINATION bin)
