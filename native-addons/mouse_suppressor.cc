#define NAPI_VERSION 8
#include <napi.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <atomic>
#include <thread>
#include <mutex>
#include <string>

namespace {

std::atomic<bool> g_suppress_next_rbuttonup(false);
std::atomic<bool> g_hook_installed(false);
std::atomic<bool> g_thread_running(false);
std::atomic<bool> g_is_synthesizing_input(false);

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

bool CheckForegroundWindowValid() {
    HWND hwnd = GetForegroundWindow();
    if (!hwnd) {
        return false;
    }
    char className[256] = {0};
    int len = GetClassNameA(hwnd, className, sizeof(className));
    if (len > 0) {
        if (_stricmp(className, "Progman") == 0 ||
            _stricmp(className, "WorkerW") == 0) {
            return false;
        }
    }
    return true;
}

void DoSendVirtualKey(WORD vk) {
    INPUT inputs[2] = {};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = vk;
    inputs[0].ki.dwFlags = 0;

    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = vk;
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;

    SendInput(2, inputs, sizeof(INPUT));
}

void DoSendUnicodeChar(wchar_t wch) {
    if (wch == L'\n') {
        DoSendVirtualKey(VK_RETURN);
        return;
    }
    if (wch == L'\r') {
        return;
    }

    INPUT inputs[2] = {};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = 0;
    inputs[0].ki.wScan = wch;
    inputs[0].ki.dwFlags = KEYEVENTF_UNICODE;

    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = 0;
    inputs[1].ki.wScan = wch;
    inputs[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;

    SendInput(2, inputs, sizeof(INPUT));
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

Napi::Value IsForegroundWindowValid(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    bool valid = CheckForegroundWindowValid();
    return Napi::Boolean::New(env, valid);
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Value SendUnicodeString(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    if (info.Length() < 1 || !info[0].IsString()) {
        return Napi::Boolean::New(env, false);
    }
    std::u16string u16str = info[0].As<Napi::String>().Utf16Value();
    g_is_synthesizing_input.store(true);
    for (char16_t ch : u16str) {
        DoSendUnicodeChar(static_cast<wchar_t>(ch));
    }
    g_is_synthesizing_input.store(false);
    return Napi::Boolean::New(env, true);
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Value SendBackspace(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    g_is_synthesizing_input.store(true);
    DoSendVirtualKey(VK_BACK);
    g_is_synthesizing_input.store(false);
    return Napi::Boolean::New(env, true);
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Value IsSynthesizingInput(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    return Napi::Boolean::New(env, g_is_synthesizing_input.load());
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
    exports.Set(Napi::String::New(env, "isForegroundWindowValid"), Napi::Function::New(env, IsForegroundWindowValid));
    exports.Set(Napi::String::New(env, "sendUnicodeString"), Napi::Function::New(env, SendUnicodeString));
    exports.Set(Napi::String::New(env, "sendBackspace"), Napi::Function::New(env, SendBackspace));
    exports.Set(Napi::String::New(env, "isSynthesizingInput"), Napi::Function::New(env, IsSynthesizingInput));

#ifdef _WIN32
    // Auto-install hook on module load
    StartHook();

    // Register cleanup hook so background thread joins cleanly on process exit
    napi_add_env_cleanup_hook(env, [](void*) {
        StopHook();
    }, nullptr);
#endif

    return exports;
}

NODE_API_MODULE(mouse_suppressor, Init)
