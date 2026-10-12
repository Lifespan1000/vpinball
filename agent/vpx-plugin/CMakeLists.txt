# Standalone build of the AgentBridge plugin. It is kept out of upstream's build files on purpose:
# a plugin is just a DLL and a plugin.cfg in VPX's plugins folder, built against the plugin headers,
# so building it here means no edits to shared build files that would conflict on every upstream merge.
#
#   cmake -S agent/vpx-plugin -B .build/agent-plugin -G "Visual Studio 18 2026" -A x64
#   cmake --build .build/agent-plugin --config Release
#
# Output goes to VPX_PLUGINS_DIR/agentbridge (defaults to the Release_BGFX x64 build of the fork).

cmake_minimum_required(VERSION 3.25)
project(AgentBridgePlugin LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(VPX_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." CACHE PATH "VPinball source tree")
set(VPX_PLUGINS_DIR "${VPX_ROOT}/.build/bin/vpx/Release_BGFX-x64/plugins" CACHE PATH "plugins folder of the VPX build to install into")

add_library(AgentBridgePlugin MODULE
   AgentBridge.cpp
   "${VPX_ROOT}/third-party/include/mongoose/mongoose.c"
)

target_include_directories(AgentBridgePlugin PRIVATE
   "${VPX_ROOT}/plugins"
   "${VPX_ROOT}/third-party/include"
)

# Same runtime choice as the upstream plugins (static CRT, no runtime DLL to ship)
set_target_properties(AgentBridgePlugin PROPERTIES
   MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
   PREFIX ""
   OUTPUT_NAME "plugin-agentbridge64"
   LIBRARY_OUTPUT_DIRECTORY "${VPX_PLUGINS_DIR}/agentbridge"
   LIBRARY_OUTPUT_DIRECTORY_RELEASE "${VPX_PLUGINS_DIR}/agentbridge"
   LIBRARY_OUTPUT_DIRECTORY_DEBUG "${VPX_PLUGINS_DIR}/agentbridge"
)

if(MSVC)
   target_compile_options(AgentBridgePlugin PRIVATE /Zc:__cplusplus /utf-8 /W3)
endif()

add_custom_command(TARGET AgentBridgePlugin POST_BUILD
   COMMAND "${CMAKE_COMMAND}" -E copy "${CMAKE_CURRENT_SOURCE_DIR}/plugin.cfg" "${VPX_PLUGINS_DIR}/agentbridge/plugin.cfg"
)
