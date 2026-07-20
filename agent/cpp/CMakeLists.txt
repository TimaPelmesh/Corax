cmake_minimum_required(VERSION 3.16)
project(corax_agent_cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(CORAX-Agent
  src/main.cpp
  src/config.cpp
  src/osdetect.cpp
  src/wmi.cpp
  src/http.cpp
  src/json_writer.cpp
  src/util.cpp
  src/collect.cpp
  src/collect_extra.cpp
  src/ui_splash.cpp
)

target_include_directories(CORAX-Agent PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)

if(MSVC)
  target_compile_definitions(CORAX-Agent PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _CRT_SECURE_NO_WARNINGS
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
    shell32
    version
    comctl32
    gdi32
    user32
  )
  set_target_properties(CORAX-Agent PROPERTIES WIN32_EXECUTABLE TRUE)
  # Keep int main() entry while using WINDOWS subsystem (no black console).
  target_link_options(CORAX-Agent PRIVATE "/ENTRY:mainCRTStartup")
endif()

install(TARGETS CORAX-Agent RUNTIME DESTINATION bin)
