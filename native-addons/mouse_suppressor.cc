#define NAPI_VERSION 8
#include <napi.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define OEMRESOURCE
#include <windows.h>
#include <atomic>
#include <thread>
#include <mutex>
#include <string>
#include <chrono>

#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

#ifndef OCR_NORMAL
#define OCR_NORMAL 32512
#endif

#ifndef OCR_IBEAM
#define OCR_IBEAM 32513
#endif

namespace {

std::atomic<bool> g_suppress_next_rbuttonup(false);
std::atomic<bool> g_hook_installed(false);
std::atomic<bool> g_thread_running(false);
std::atomic<bool> g_is_synthesizing_input(false);
std::atomic<bool> g_busy_cursor_active(false);

HHOOK g_hook = nullptr;
DWORD g_hook_thread_id = 0;
std::thread g_hook_thread;
std::mutex g_init_mutex;

// Input Listener Thread & ThreadSafeFunction
std::atomic<bool> g_input_thread_running(false);
std::thread g_input_thread;
Napi::ThreadSafeFunction g_tsfn = nullptr;
std::mutex g_tsfn_mutex;

struct InputEventData {
    std::string type;
    int x;
    int y;
};

void DispatchNativeEvent(const std::string& type, int x = 0, int y = 0) {
    std::lock_guard<std::mutex> lock(g_tsfn_mutex);
    if (!g_tsfn) return;

    InputEventData* data = new InputEventData{ type, x, y };
    napi_status status = g_tsfn.NonBlockingCall(data, [](Napi::Env env, Napi::Function jsCallback, InputEventData* data) {
        if (env != nullptr && jsCallback != nullptr && data != nullptr) {
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("type", Napi::String::New(env, data->type));
            obj.Set("x", Napi::Number::New(env, data->x));
            obj.Set("y", Napi::Number::New(env, data->y));
            jsCallback.Call({ obj });
        }
        delete data;
    });

    if (status != napi_ok) {
        delete data;
    }
}

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

// -----------------------------------------------------------------------------
// ASYNCHRONOUS KEYSTATE MONITORING WORKER THREAD (GetAsyncKeyState)
// -----------------------------------------------------------------------------
void InputMonitoringThreadFunction() {
    using clock = std::chrono::steady_clock;

    // Tracking states
    bool rctrl_rshift_latched = false;
    bool rctrl_right_latched = false;
    bool rctrl_delete_latched = false;

    // Arrow Up tracking
    bool arrow_up_was_down = false;
    bool arrow_up_hold_triggered = false;
    clock::time_point arrow_up_down_time;

    // Arrow Down tracking
    bool arrow_down_was_down = false;
    bool arrow_down_hold_triggered = false;
    clock::time_point arrow_down_down_time;

    // Region selection tracking (L-CTRL + L-SHIFT)
    bool region_combo_was_down = false;
    bool region_hold_triggered = false;
    clock::time_point region_down_time;

    // R-ALT + R-CTRL tracking (strict right-side modifiers, AltGr-safe)
    bool ralt_combo_was_down = false;
    bool ralt_hold_triggered = false;
    clock::time_point ralt_down_time = clock::time_point::min();
    clock::time_point last_ralt_release_time = clock::time_point::min();
    clock::time_point last_ralt_hold_time = clock::time_point::min();

    // Push-to-Talk voice tracking (Mouse Left + Mouse Right)
    bool voice_combo_was_down = false;
    bool voice_recording_active = false;
    clock::time_point voice_down_time;

    // Cooldown timestamps for strict 250ms debounce on cycling hotkeys
    const auto debounce_cooldown = std::chrono::milliseconds(250);
    clock::time_point last_profile_cycle_time = clock::time_point::min();
    clock::time_point last_reasoning_cycle_time = clock::time_point::min();
    clock::time_point last_model_cycle_time = clock::time_point::min();

    while (g_input_thread_running.load()) {
        auto now = clock::now();

        // 1. Query physical keystates directly from OS subsystem
        bool isRCtrl = (GetAsyncKeyState(VK_RCONTROL) & 0x8000) != 0;
        bool isLCtrl = (GetAsyncKeyState(VK_LCONTROL) & 0x8000) != 0;
        bool isRShift = (GetAsyncKeyState(VK_RSHIFT) & 0x8000) != 0;
        bool isLShift = (GetAsyncKeyState(VK_LSHIFT) & 0x8000) != 0;
        bool isRAlt = (GetAsyncKeyState(VK_RMENU) & 0x8000) != 0;
        // AltGr safeguard: Windows emits synthetic VK_LCONTROL when physical R-ALT is pressed on AltGr layouts
        bool isRealLCtrl = isLCtrl && !isRAlt;

        bool isKeyUp = (GetAsyncKeyState(VK_UP) & 0x8000) != 0;
        bool isKeyDown = (GetAsyncKeyState(VK_DOWN) & 0x8000) != 0;
        bool isKeyRight = (GetAsyncKeyState(VK_RIGHT) & 0x8000) != 0;
        bool isKeyDelete = (GetAsyncKeyState(VK_DELETE) & 0x8000) != 0;

        bool isLButton = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
        bool isRButton = (GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0;

        // Skip synthetic inputs during auto-typer injection
        if (!g_is_synthesizing_input.load()) {

            // --- HOTKEY 0: Cycle Output Profile: R-CTRL + R-SHIFT (Tap) ---
            bool isProfileCombo = (isRCtrl && isRShift);
            if (isProfileCombo && !rctrl_rshift_latched) {
                rctrl_rshift_latched = true;
                if (last_profile_cycle_time == clock::time_point::min() ||
                    (now - last_profile_cycle_time) >= debounce_cooldown) {
                    last_profile_cycle_time = now;
                    DispatchNativeEvent("cycle-profile");
                }
            } else if (!isProfileCombo) {
                rctrl_rshift_latched = false;
            }

            // --- HOTKEY 1: Fullscreen Capture / Model Cycle: R-CTRL + Arrow Up ---
            if (isRCtrl && isKeyUp) {
                if (!arrow_up_was_down) {
                    arrow_up_was_down = true;
                    arrow_up_hold_triggered = false;
                    arrow_up_down_time = now;
                } else if (!arrow_up_hold_triggered) {
                    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - arrow_up_down_time).count();
                    if (elapsed >= 400) {
                        arrow_up_hold_triggered = true;
                        if (last_model_cycle_time == clock::time_point::min() ||
                            (now - last_model_cycle_time) >= debounce_cooldown) {
                            last_model_cycle_time = now;
                            DispatchNativeEvent("cycle-model");
                        }
                    }
                }
            } else if (arrow_up_was_down) {
                // Key released
                arrow_up_was_down = false;
                if (!arrow_up_hold_triggered) {
                    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - arrow_up_down_time).count();
                    if (elapsed < 400) {
                        DispatchNativeEvent("screen-capture-fullscreen");
                    }
                }
                arrow_up_hold_triggered = false;
            }

            // --- HOTKEY 2: Dynamic Region Capture: L-CTRL + L-SHIFT (strictly without R-CTRL or AltGr R-ALT) ---
            if (isRealLCtrl && isLShift && !isRCtrl && !isRAlt) {
                if (!region_combo_was_down) {
                    region_combo_was_down = true;
                    region_hold_triggered = false;
                    region_down_time = now;
                } else if (!region_hold_triggered) {
                    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - region_down_time).count();
                    if (elapsed >= 1000) {
                        region_hold_triggered = true;
                        POINT pt;
                        GetCursorPos(&pt);
                        DispatchNativeEvent("region-start", pt.x, pt.y);
                    }
                }
            } else if (region_combo_was_down) {
                region_combo_was_down = false;
                if (region_hold_triggered) {
                    region_hold_triggered = false;
                    POINT pt;
                    GetCursorPos(&pt);
                    DispatchNativeEvent("region-finish", pt.x, pt.y);
                }
            }

            // --- HOTKEY 3: Send Staged Items: R-CTRL + Arrow Right ---
            if (isRCtrl && isKeyRight) {
                if (!rctrl_right_latched) {
                    rctrl_right_latched = true;
                    DispatchNativeEvent("send-staged");
                }
            } else {
                rctrl_right_latched = false;
            }

            // --- HOTKEY 4: Clear Staged Items: R-CTRL + Delete ---
            if (isRCtrl && isKeyDelete) {
                if (!rctrl_delete_latched) {
                    rctrl_delete_latched = true;
                    DispatchNativeEvent("clear-staged");
                }
            } else {
                rctrl_delete_latched = false;
            }

            // --- HOTKEY 5: Answer Replay, Resumable Auto-Typer & Hard Stop: R-ALT + R-CTRL ---
            bool isRAltCombo = (isRAlt && isRCtrl);
            if (isRAltCombo) {
                if (!ralt_combo_was_down) {
                    bool bounceSafe = (last_ralt_release_time == clock::time_point::min() ||
                        std::chrono::duration_cast<std::chrono::milliseconds>(now - last_ralt_release_time).count() >= 40);
                    if (bounceSafe) {
                        ralt_combo_was_down = true;
                        ralt_hold_triggered = false;
                        ralt_down_time = now;
                        DispatchNativeEvent("r-alt-down");
                    }
                } else if (!ralt_hold_triggered) {
                    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - ralt_down_time).count();
                    if (elapsed >= 500) {
                        ralt_hold_triggered = true;
                        if (last_ralt_hold_time == clock::time_point::min() ||
                            (now - last_ralt_hold_time) >= debounce_cooldown) {
                            last_ralt_hold_time = now;
                            DispatchNativeEvent("r-alt-hold");
                        }
                    }
                }
            } else if (ralt_combo_was_down) {
                ralt_combo_was_down = false;
                last_ralt_release_time = now;
                if (!ralt_hold_triggered) {
                    DispatchNativeEvent("r-alt-tap");
                }
                ralt_hold_triggered = false;
            }

            // --- HOTKEY 6: Reasoning / Mode Toggle: R-CTRL + Arrow Down ---
            if (isRCtrl && isKeyDown) {
                if (!arrow_down_was_down) {
                    arrow_down_was_down = true;
                    arrow_down_hold_triggered = false;
                    arrow_down_down_time = now;
                } else if (!arrow_down_hold_triggered) {
                    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - arrow_down_down_time).count();
                    if (elapsed >= 1000) {
                        arrow_down_hold_triggered = true;
                        DispatchNativeEvent("toggle-submode");
                    }
                }
            } else if (arrow_down_was_down) {
                arrow_down_was_down = false;
                if (!arrow_down_hold_triggered) {
                    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - arrow_down_down_time).count();
                    if (elapsed < 400) {
                        if (last_reasoning_cycle_time == clock::time_point::min() ||
                            (now - last_reasoning_cycle_time) >= debounce_cooldown) {
                            last_reasoning_cycle_time = now;
                            DispatchNativeEvent("cycle-reasoning");
                        }
                    }
                }
                arrow_down_hold_triggered = false;
            }

            // --- HOTKEY 7: Push-to-Talk Voice: Mouse Left + Mouse Right (Hold >= 1000ms) ---
            if (isLButton && isRButton) {
                if (!voice_combo_was_down) {
                    voice_combo_was_down = true;
                    voice_recording_active = false;
                    voice_down_time = now;
                } else if (!voice_recording_active) {
                    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - voice_down_time).count();
                    if (elapsed >= 1000) {
                        voice_recording_active = true;
                        DispatchNativeEvent("voice-start");
                    }
                }
            } else if (voice_combo_was_down) {
                voice_combo_was_down = false;
                if (voice_recording_active) {
                    voice_recording_active = false;
                    // Suppress right-click context menu automatically
                    g_suppress_next_rbuttonup.store(true);
                    DispatchNativeEvent("voice-stop");
                }
            }
        }

        // 12ms sleep interval for 80 Hz polling cadence
        std::this_thread::sleep_for(std::chrono::milliseconds(12));
    }
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
    if (wch == L'\t') {
        DoSendVirtualKey(VK_TAB);
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

void DoReleaseModifiers() {
    const WORD modifiers[] = {
        VK_RCONTROL, VK_LCONTROL,
        VK_RSHIFT,   VK_LSHIFT,
        VK_RMENU,    VK_LMENU
    };
    INPUT inputs[6] = {};
    for (int i = 0; i < 6; ++i) {
        inputs[i].type = INPUT_KEYBOARD;
        inputs[i].ki.wVk = modifiers[i];
        inputs[i].ki.dwFlags = KEYEVENTF_KEYUP;
    }
    g_is_synthesizing_input.store(true);
    SendInput(6, inputs, sizeof(INPUT));
    g_is_synthesizing_input.store(false);
}

bool SetBusyCursorState(bool busy) {
    if (busy) {
        HCURSOR waitCursor = LoadCursor(nullptr, IDC_WAIT);
        if (!waitCursor) {
            return false;
        }
        HCURSOR copyNormal = CopyIcon(waitCursor);
        HCURSOR copyIBeam = CopyIcon(waitCursor);
        bool ok1 = copyNormal ? (SetSystemCursor(copyNormal, OCR_NORMAL) != FALSE) : false;
        if (!ok1 && copyNormal) {
            DestroyCursor(copyNormal);
        }
        bool ok2 = copyIBeam ? (SetSystemCursor(copyIBeam, OCR_IBEAM) != FALSE) : false;
        if (!ok2 && copyIBeam) {
            DestroyCursor(copyIBeam);
        }
        g_busy_cursor_active.store(ok1 || ok2);
        return ok1 || ok2;
    }

    BOOL restored = SystemParametersInfo(SPI_SETCURSORS, 0, nullptr, 0);
    g_busy_cursor_active.store(false);
    return restored != FALSE;
}

} // namespace
#endif

// -----------------------------------------------------------------------------
// NODE-API EXPORTS
// -----------------------------------------------------------------------------

Napi::Value StartInputListener(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected callback function").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::lock_guard<std::mutex> lock(g_tsfn_mutex);
    if (g_input_thread_running.load()) {
        return Napi::Boolean::New(env, true);
    }

    Napi::Function callback = info[0].As<Napi::Function>();
    g_tsfn = Napi::ThreadSafeFunction::New(
        env,
        callback,
        "OmniscienceNativeInputListener",
        0,
        1
    );

    g_input_thread_running.store(true);
    g_input_thread = std::thread(InputMonitoringThreadFunction);

    return Napi::Boolean::New(env, true);
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Value StopInputListener(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    if (!g_input_thread_running.load()) {
        return Napi::Boolean::New(env, true);
    }

    g_input_thread_running.store(false);
    if (g_input_thread.joinable()) {
        g_input_thread.join();
    }

    std::lock_guard<std::mutex> lock(g_tsfn_mutex);
    if (g_tsfn) {
        g_tsfn.Release();
        g_tsfn = nullptr;
    }

    return Napi::Boolean::New(env, true);
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Value SetWindowExcludeFromCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    if (info.Length() < 1 || !info[0].IsBuffer()) {
        return Napi::Boolean::New(env, false);
    }
    Napi::Buffer<char> buf = info[0].As<Napi::Buffer<char>>();
    if (buf.Length() < sizeof(HWND)) {
        return Napi::Boolean::New(env, false);
    }

    HWND hwnd = *reinterpret_cast<HWND*>(buf.Data());
    if (!hwnd || !IsWindow(hwnd)) {
        return Napi::Boolean::New(env, false);
    }

    BOOL ok = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    if (!ok) {
        // Fallback for older Windows 10 builds
        ok = SetWindowDisplayAffinity(hwnd, 0x00000001);
    }
    return Napi::Boolean::New(env, ok != FALSE);
#else
    return Napi::Boolean::New(env, false);
#endif
}

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

Napi::Value ReleaseModifiers(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    DoReleaseModifiers();
    return Napi::Boolean::New(env, true);
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Value SetBusyCursor(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    bool busy = false;
    if (info.Length() >= 1 && info[0].IsBoolean()) {
        busy = info[0].As<Napi::Boolean>().Value();
    }
    bool ok = SetBusyCursorState(busy);
    return Napi::Boolean::New(env, ok);
#else
    return Napi::Boolean::New(env, false);
#endif
}

Napi::Value IsHardwareRAltDown(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef _WIN32
    return Napi::Boolean::New(env, (GetAsyncKeyState(VK_RMENU) & 0x8000) != 0);
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
    exports.Set(Napi::String::New(env, "releaseModifiers"), Napi::Function::New(env, ReleaseModifiers));
    exports.Set(Napi::String::New(env, "setBusyCursor"), Napi::Function::New(env, SetBusyCursor));
    exports.Set(Napi::String::New(env, "isHardwareRAltDown"), Napi::Function::New(env, IsHardwareRAltDown));
    exports.Set(Napi::String::New(env, "startInputListener"), Napi::Function::New(env, StartInputListener));
    exports.Set(Napi::String::New(env, "stopInputListener"), Napi::Function::New(env, StopInputListener));
    exports.Set(Napi::String::New(env, "setWindowExcludeFromCapture"), Napi::Function::New(env, SetWindowExcludeFromCapture));

#ifdef _WIN32
    // Auto-install suppression hook on module load
    StartHook();

    // Register cleanup hook so background threads join cleanly and system cursor restores on process exit
    napi_add_env_cleanup_hook(env, [](void*) {
        if (g_busy_cursor_active.load()) {
            SetBusyCursorState(false);
        }
        if (g_input_thread_running.load()) {
            g_input_thread_running.store(false);
            if (g_input_thread.joinable()) {
                g_input_thread.join();
            }
        }
        StopHook();
    }, nullptr);
#endif

    return exports;
}

NODE_API_MODULE(mouse_suppressor, Init)
