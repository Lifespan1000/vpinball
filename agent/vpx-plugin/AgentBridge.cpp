// license:GPLv3+

// AgentBridge: lets a local agent observe and drive a running table over HTTP (localhost only).
//
// - POST /api/script  runs VBScript in the table's script context. The code reports results with
//                     AgentBridge.Report "<text>", so anything the script can see is observable
//                     (balls, lights, switches, score variables), and handlers can be redefined live.
// - POST /api/input   presses, releases or pulses a player action (flippers, plunger, start, ...)
// - GET  /api/balls   positions and velocities of the balls in play
// - GET  /api/info    whether a game runs, game time, table
//
// The plugin API is single threaded: the web server thread queues every request on the main thread
// and waits for it with a timeout, never blocking on it (the main thread may be unloading the plugin,
// which joins the web server thread). /api/script runs arbitrary code, hence the plugin is disabled
// by default and only listens on 127.0.0.1.

#include "plugins/MsgPlugin.h"
#include "plugins/VPXPlugin.h"
#include "plugins/ScriptablePlugin.h"
#include "plugins/LoggingPlugin.h"

#include <mongoose/mongoose.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

using namespace std::string_literals;
using json = nlohmann::json;

LPI_IMPLEMENT_CPP

namespace AgentBridge
{

static const MsgPluginAPI* msgApi = nullptr;
static VPXPluginAPI* vpxApi = nullptr;
static ScriptablePluginAPI* scriptApi = nullptr;
static uint32_t endpointId;
static unsigned int getVpxApiId, getScriptApiId, onGameStartId, onGameEndId;

MSGPI_INT_VAL_SETTING(portSetting, "Port", "Port", "Local port of the agent bridge web server", true, 1024, 65535, 2114);

static std::atomic<bool> gameRunning = false;
static std::atomic<bool> stopping = false;


///////////////////////////////////////////////////////////////////////////////
// Main thread hand-off

struct Job
{
   std::function<json()> fn;
   json result;
   std::mutex mutex;
   std::condition_variable cv;
   bool done = false;
};

// Runs fn on the main thread and returns its result, or nullopt if it did not run within the timeout.
// The job is shared with the queued callback, so a late run after a timeout writes to live memory.
static std::optional<json> RunOnMain(std::function<json()> fn, int timeoutMs)
{
   auto job = std::make_shared<Job>();
   job->fn = std::move(fn);
   msgApi->RunOnMainThread(endpointId, 0.0,
      [](void* userData)
      {
         std::unique_ptr<std::shared_ptr<Job>> holder(static_cast<std::shared_ptr<Job>*>(userData));
         Job& j = **holder;
         json result = stopping ? json { { "error", "plugin is unloading" } } : j.fn();
         {
            std::lock_guard lock(j.mutex);
            j.result = std::move(result);
            j.done = true;
         }
         j.cv.notify_all();
      },
      new std::shared_ptr<Job>(job));
   std::unique_lock lock(job->mutex);
   if (!job->cv.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] { return job->done; }))
      return std::nullopt;
   return job->result;
}


///////////////////////////////////////////////////////////////////////////////
// Script reporting object (AgentBridge.Report / Fail / Done), only used on the main thread

static std::vector<std::string> reports;
static std::string scriptError;
static bool scriptDone = false;
static bool bridgeObjectDefined = false;
static unsigned int runCounter = 0;

static const char* ArgString(ScriptVariant* pArgs) { return pArgs[0].vString.string ? pArgs[0].vString.string : ""; }

static ScriptClassDef reporterClass = { { "AgentBridgeReporter" }, []() -> void* { static int instance; return &instance; }, 5,
   {
      // The object is a static singleton: reference counting is a no-op. PSC_ADD_REF / PSC_RELEASE call
      // these with null arguments and return slot, so they must not touch pRet
      { { "AddRef" }, { "ulong" }, 0, {}, [](void*, int, ScriptVariant*, ScriptVariant*) { } },
      { { "Release" }, { "ulong" }, 0, {}, [](void*, int, ScriptVariant*, ScriptVariant*) { } },
      { { "Report" }, { "void" }, 1, { { "string" } }, [](void*, int, ScriptVariant* pArgs, ScriptVariant*) { reports.emplace_back(ArgString(pArgs)); } },
      { { "Fail" }, { "void" }, 1, { { "string" } }, [](void*, int, ScriptVariant* pArgs, ScriptVariant*) { scriptError = ArgString(pArgs); } },
      { { "Done" }, { "void" }, 0, {}, [](void*, int, ScriptVariant*, ScriptVariant*) { scriptDone = true; } },
   } };

// Runs agent code. By default the code is the body of a new Sub, so it may Dim its own variables
// and its runtime errors are trapped and reported. With raw, it is evaluated at global scope, for
// defining or replacing Subs (event handlers) of the running table. A missing Done means the code
// did not compile (VPX logs the error) or failed in raw mode.
static json RunAgentScript(const std::string& code, bool raw)
{
   if (!gameRunning)
      return json { { "error", "no game is running" } };
   if (!bridgeObjectDefined)
   {
      vpxApi->RunScript("Dim AgentBridge : Set AgentBridge = CreatePluginObject(\"AgentBridgeReporter\")");
      bridgeObjectDefined = true;
   }
   reports.clear();
   scriptError.clear();
   scriptDone = false;
   std::string script;
   if (raw)
      script = code + "\nAgentBridge.Done\n";
   else
   {
      const std::string sub = "AgentBridge_Run" + std::to_string(++runCounter);
      script = "Sub " + sub + "()\nOn Error Resume Next\n" + code
         + "\nIf Err.Number <> 0 Then AgentBridge.Fail \"Error \" & Err.Number & \": \" & Err.Description\nAgentBridge.Done\nEnd Sub\n" + sub + "\n";
   }
   vpxApi->RunScript(script.c_str());
   json result { { "reports", reports }, { "completed", scriptDone } };
   if (!scriptError.empty())
      result["error"] = scriptError;
   else if (!scriptDone)
      result["error"] = "the code did not run to completion (compile error, or runtime error in raw mode): see the VPX log";
   return result;
}

static const char* const ballsScript = R"(Dim b, s : s = ""
For Each b In GetBalls
If s <> "" Then s = s & ","
s = s & "{""x"":" & b.X & ",""y"":" & b.Y & ",""z"":" & b.Z & ",""vx"":" & b.VelX & ",""vy"":" & b.VelY & ",""vz"":" & b.VelZ & ",""radius"":" & b.Radius & "}"
Next
AgentBridge.Report "[" & s & "]")";


///////////////////////////////////////////////////////////////////////////////
// Player input

static const std::pair<const char*, VPXAction> actionNames[] = {
   { "LeftFlipper", VPXACTION_LeftFlipper }, { "RightFlipper", VPXACTION_RightFlipper },
   { "StagedLeftFlipper", VPXACTION_StagedLeftFlipper }, { "StagedRightFlipper", VPXACTION_StagedRightFlipper },
   { "LeftMagnaSave", VPXACTION_LeftMagnaSave }, { "RightMagnaSave", VPXACTION_RightMagnaSave },
   { "LaunchBall", VPXACTION_LaunchBall }, { "LeftNudge", VPXACTION_LeftNudge }, { "CenterNudge", VPXACTION_CenterNudge },
   { "RightNudge", VPXACTION_RightNudge }, { "Tilt", VPXACTION_Tilt }, { "AddCredit", VPXACTION_AddCredit },
   { "AddCredit2", VPXACTION_AddCredit2 }, { "StartGame", VPXACTION_StartGame }, { "Lockbar", VPXACTION_Lockbar },
   { "Pause", VPXACTION_Pause }, { "ExitGame", VPXACTION_ExitGame },
};

static void SetAction(VPXAction action, bool pressed)
{
   VPXInputState state {};
   state.actionMask = 1ULL << action;
   state.actionState = pressed ? state.actionMask : 0;
   vpxApi->SetInputState(&state);
}


///////////////////////////////////////////////////////////////////////////////
// Web server

static std::unique_ptr<std::thread> serverThread;
static std::atomic<bool> serverRun = false;
static mg_mgr mgr;

static void Reply(mg_connection* c, int status, const json& body)
{
   mg_http_reply(c, status, "Content-Type: application/json\r\n", "%s\n", body.dump().c_str());
}

static void HandleRequest(mg_connection* c, mg_http_message* hm)
{
   const auto timeoutReply = [c] { Reply(c, 504, { { "error", "the main thread did not run the request in time (loading, or paused in a dialog?)" } }); };
   if (mg_match(hm->uri, mg_str("/api/info"), nullptr))
   {
      const auto r = RunOnMain([]
         {
            json info { { "game_running", gameRunning.load() } };
            if (gameRunning)
            {
               VPXTableInfo table {};
               vpxApi->GetTableInfo(&table);
               info["game_time"] = vpxApi->GetGameTime();
               info["table"] = { { "path", table.path ? table.path : "" }, { "width", table.tableWidth }, { "height", table.tableHeight } };
            }
            return info;
         }, 5000);
      return r ? Reply(c, 200, *r) : timeoutReply();
   }
   if (mg_match(hm->uri, mg_str("/api/balls"), nullptr))
   {
      const auto r = RunOnMain([]
         {
            json result = RunAgentScript(ballsScript, false);
            if (result.contains("error"))
               return result;
            return json { { "game_time", vpxApi->GetGameTime() }, { "balls", json::parse(result["reports"].at(0).get<std::string>(), nullptr, false) } };
         }, 5000);
      return r ? Reply(c, r->contains("error") ? 409 : 200, *r) : timeoutReply();
   }

   json body = json::parse(std::string(hm->body.buf, hm->body.len), nullptr, false);
   if (mg_strcmp(hm->method, mg_str("POST")) != 0 || body.is_discarded() || !body.is_object())
      return Reply(c, 400, { { "error", "expected a POST with a JSON object body" } });

   if (mg_match(hm->uri, mg_str("/api/script"), nullptr))
   {
      if (!body.contains("code") || !body["code"].is_string())
         return Reply(c, 400, { { "error", "missing \"code\" (VBScript string)" } });
      const std::string code = body["code"];
      const bool raw = body.value("raw", false);
      const auto r = RunOnMain([code, raw] { return RunAgentScript(code, raw); }, body.value("timeout_ms", 10000));
      // Errors of the agent's code are a normal result (200); 409 is only for 'no game running'
      return r ? Reply(c, r->contains("completed") ? 200 : 409, *r) : timeoutReply();
   }

   if (mg_match(hm->uri, mg_str("/api/input"), nullptr))
   {
      const std::string name = body.value("action", ""s);
      const auto it = std::ranges::find_if(actionNames, [&name](const auto& a) { return name == a.first; });
      if (it == std::end(actionNames))
      {
         json names = json::array();
         for (const auto& a : actionNames)
            names.push_back(a.first);
         return Reply(c, 400, { { "error", "unknown action \"" + name + '"' }, { "actions", names } });
      }
      const VPXAction action = it->second;
      const int pulseMs = body.value("pulse_ms", 0);
      const bool press = body.value("press", true);
      const auto r = RunOnMain([action, press, pulseMs]
         {
            if (!gameRunning)
               return json { { "error", "no game is running" } };
            SetAction(action, pulseMs > 0 ? true : press);
            // A pulse is released by a delayed main thread callback, so the request does not wait for it
            if (pulseMs > 0)
               msgApi->RunOnMainThread(endpointId, pulseMs / 1000.0,
                  [](void* userData) { if (gameRunning && !stopping) SetAction(static_cast<VPXAction>(reinterpret_cast<uintptr_t>(userData)), false); },
                  reinterpret_cast<void*>(static_cast<uintptr_t>(action)));
            return json { { "ok", true } };
         }, 5000);
      return r ? Reply(c, r->contains("error") ? 409 : 200, *r) : timeoutReply();
   }

   Reply(c, 404, { { "error", "unknown endpoint" }, { "endpoints", { "GET /api/info", "GET /api/balls", "POST /api/script", "POST /api/input" } } });
}

static void EventHandler(mg_connection* c, int ev, void* evData)
{
   if (ev == MG_EV_HTTP_MSG)
      HandleRequest(c, static_cast<mg_http_message*>(evData));
}

static void MSGPIAPI OnGameStart(const unsigned int, void*, void*)
{
   // A new game has a new script context: the AgentBridge object must be defined again
   bridgeObjectDefined = false;
   gameRunning = true;
}

static void MSGPIAPI OnGameEnd(const unsigned int, void*, void*) { gameRunning = false; }

static void StartServer()
{
   const std::string url = "http://127.0.0.1:" + std::to_string(portSetting_Get());
   mg_mgr_init(&mgr);
   if (!mg_http_listen(&mgr, url.c_str(), EventHandler, nullptr))
   {
      LPI_LOGE_CPP("Unable to listen on " + url);
      mg_mgr_free(&mgr);
      return;
   }
   LPI_LOGI_CPP("Listening on " + url);
   serverRun = true;
   serverThread = std::make_unique<std::thread>([] {
      while (serverRun)
         mg_mgr_poll(&mgr, 50);
      mg_mgr_free(&mgr);
   });
}

static void StopServer()
{
   serverRun = false;
   if (serverThread && serverThread->joinable())
      serverThread->join();
   serverThread.reset();
}

}

using namespace AgentBridge;

MSGPI_EXPORT void MSGPIAPI AgentBridgePluginLoad(const uint32_t sessionId, const MsgPluginAPI* api)
{
   msgApi = api;
   endpointId = sessionId;
   stopping = false;
   LPISetup(endpointId, msgApi);
   msgApi->BroadcastMsg(endpointId, getVpxApiId = msgApi->GetMsgID(VPXPI_NAMESPACE, VPXPI_MSG_GET_API), &vpxApi);
   msgApi->BroadcastMsg(endpointId, getScriptApiId = msgApi->GetMsgID(SCRIPTPI_NAMESPACE, SCRIPTPI_MSG_GET_API), &scriptApi);
   msgApi->RegisterSetting(endpointId, &portSetting);

   scriptApi->RegisterScriptClass(&reporterClass);
   scriptApi->SubmitTypeLibrary(endpointId);
   scriptApi->SetCOMObjectOverride("AgentBridgeReporter", &reporterClass);

   msgApi->SubscribeMsg(endpointId, onGameStartId = msgApi->GetMsgID(VPXPI_NAMESPACE, VPXPI_EVT_ON_GAME_START), OnGameStart, nullptr);
   msgApi->SubscribeMsg(endpointId, onGameEndId = msgApi->GetMsgID(VPXPI_NAMESPACE, VPXPI_EVT_ON_GAME_END), OnGameEnd, nullptr);

   StartServer();
}

MSGPI_EXPORT void MSGPIAPI AgentBridgePluginUnload()
{
   stopping = true;
   gameRunning = false;
   // The server thread may be waiting on a queued job: it times out, then the flush runs the
   // leftover jobs, which see 'stopping' and do nothing
   StopServer();
   msgApi->FlushPendingCallbacks(endpointId);
   msgApi->UnsubscribeMsg(onGameStartId, OnGameStart, nullptr);
   msgApi->UnsubscribeMsg(onGameEndId, OnGameEnd, nullptr);
   scriptApi->SetCOMObjectOverride("AgentBridgeReporter", nullptr);
   scriptApi->UnregisterScriptClass(&reporterClass);
   msgApi->ReleaseMsgID(getVpxApiId);
   msgApi->ReleaseMsgID(getScriptApiId);
   msgApi->ReleaseMsgID(onGameStartId);
   msgApi->ReleaseMsgID(onGameEndId);
   vpxApi = nullptr;
   scriptApi = nullptr;
   msgApi = nullptr;
}
