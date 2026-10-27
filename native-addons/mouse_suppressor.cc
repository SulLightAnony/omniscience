#define NAPI_VERSION 8
#include <napi.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <atomic>
#include <thread>
#include <mutex>

namespace {

std::atomic<bool> g_suppress_next_rbuttonup(false);
std::atomic<bool> g_hook_installed(false);
std::atomic<bool> g_thread_running(false);

HHOOK g_hook = nullptr;
DWORD g_hook_thread_id = 0;
std::thread g_hook_thread;
std::mutex g_init_mutex;

LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode >= 0) {
        if (wParam == WM_RBUTTONUP) {
            if (g_suppress_next_rbuttonup.exchange(false)) {
                // Return 1 to prevent Windows from routing WM_RBUTTONUP to active applications.
                return 1;
            }
        }
    }
    return CallNextHookEx(g_hook, nCode, wParam, lParam);
}

void HookThreadFunction() {
    g_hook_thread_id = GetCurrentThreadId();
    g_hook = SetWindowsHookEx(WH_MOUSE_LL, LowLevelMouseProc, GetModuleHandle(nullptr), 0);

    if (g_hook == nullptr) {
        g_hook_installed.store(false);
        g_thread_running.store(false);
        return;
    }

    g_hook_installed.store(true);
    g_thread_running.store(true);

    MSG msg;
    while (g_thread_running.load() && GetMessage(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    if (g_hook != nullptr) {
        UnhookWindowsHookEx(g_hook);
        g_hook = nullptr;
    }
    g_hook_installed.store(false);
}

bool StartHook() {
    std::lock_guard<std::mutex> lock(g_init_mutex);
    if (g_hook_installed.load() || g_thread_running.load()) {
        return true;
    }

    g_thread_running.store(true);
    g_hook_thread = std::thread(HookThreadFunction);

    // Wait up to 500ms for the hook thread to initialize
    int waited_ms = 0;
    while (!g_hook_installed.load() && waited_ms < 500) {
        Sleep(10);
        waited_ms += 10;
    }

    return g_hook_installed.load();
}

void StopHook() {
    std::lock_guard<std::mutex> lock(g_init_mutex);
    if (!g_thread_running.load()) {
        return;
    }

    g_thread_running.store(false);
    if (g_hook_thread_id != 0) {
        PostThreadMessage(g_hook_thread_id, WM_QUIT, 0, 0);
    }

    if (g_hook_thread.joinable()) {
        g_hook_thread.join();
    }

    g_hook_thread_id = 0;
    g_hook_installed.store(false);
}

} // namespace
#endif

Napi::Value EnableSuppression(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    if (!g_hook_installed.load()) {
        StartHook();
    }
    g_suppress_next_rbuttonup.store(true);
    return Napi::Boolean::New(env, true);
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Value DisableSuppression(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    g_suppress_next_rbuttonup.store(false);
    return Napi::Boolean::New(env, true);
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Value IsSuppressionArmed(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    return Napi::Boolean::New(env, g_suppress_next_rbuttonup.load());
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Value InstallHook(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    bool ok = StartHook();
    return Napi::Boolean::New(env, ok);
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Value UninstallHook(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    StopHook();
    return Napi::Boolean::New(env, true);
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "enableSuppression"), Napi::Function::New(env, EnableSuppression));
    exports.Set(Napi::String::New(env, "disableSuppression"), Napi::Function::New(env, DisableSuppression));
    exports.Set(Napi::String::New(env, "isSuppressionArmed"), Napi::Function::New(env, IsSuppressionArmed));
    exports.Set(Napi::String::New(env, "installHook"), Napi::Function::New(env, InstallHook));
    exports.Set(Napi::String::New(env, "uninstallHook"), Napi::Function::New(env, UninstallHook));

#ifdef _WIN32
    // Auto-install hook on module load
    StartHook();
#endif

    return exports;
}

NODE_API_MODULE(mouse_suppressor, Init)
