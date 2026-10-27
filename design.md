# System Architecture & Technical Design Specification: Omniscience

---

## 1. System Overview & Core Design Philosophy

**Omniscience** is a standalone Windows 10/11 desktop application packaged as a native executable (`.exe`) with top-level operating system access capable of capturing screenshots from any active application window, recording voice instructions, solving complex problems using multimodal AI reasoning, and delivering spoken answers directly to a connected audio output device.

The application is engineered around a **Dual-Mode Architecture**:

1. **Main Interface Mode (Visible Desktop Client):**
* A local, single-user AI chat workspace modeled after the clean Google Gemini web interface.
* Operates strictly on the **"Gemini 3.8 Flash"** model using the official API model identifier `"gemini-3.8-flash"`, with three configurable reasoning levels: `Low`, `Medium`, and `High`.
* Users can create new conversations, browse and resume past conversations, and attach local files or images without requiring any login or authentication system.


2. **Companion Mode (Stealth Background Agent):**
* Activated via a dedicated vector icon button inside the active conversation interface. Once armed, closing the main application window transitions Omniscience into a silent background agent without losing any functionality.
* In Companion Mode, the application **displays zero visual elements on the workspace** and **does not appear on the Windows Taskbar**.
* To prevent Windows 10/11 security policies from flagging or terminating the background process—and to give the user manual control—Omniscience maintains an icon inside the **Windows System Tray**. The main interface can be restored at any time by double-clicking the System Tray icon, selecting open from the System Tray context menu, or manually re-launching `Omniscience.exe`.



### Mandatory Engineering Standards

* **Zero-Emoji Policy:** The use of emoji characters is strictly prohibited across the entire source code, user interface, status indicators, System Tray menus, and console logs. Every visual indicator and button must use pure inline SVG vector icons from the local **Lucide Icons** library.
* **Zero-Tailwind Policy (Pure Modern CSS3):** Tailwind CSS and utility-first CSS frameworks are strictly forbidden. All styling must be written in **Modern Vanilla CSS3** using CSS Custom Properties (CSS Variables), CSS Grid, Flexbox, and structured **BEM (Block-Element-Modifier)** naming conventions.
* **Full English Localization:** All user interface labels, System Tray menus, system prompts, voice transcriptions (STT), and Text-to-Speech (TTS) audio outputs operate exclusively in English.

---

## 2. Programming Language, Technical Modules, & Development Toolchain

### 2.1 Primary Programming Language & Runtime

The optimal architecture for combining a Gemini-style desktop interface with a low-latency Windows background daemon is **JavaScript (ES6+) / Node.js** running on **Electron**, extended with a compiled **C++ Native Addon (Node N-API)**.

* **Technical Justification:**
1. **Native Window Lifecycle & System Tray Control:** Electron provides direct OS-level APIs (`mainWindow.hide()`, `mainWindow.setSkipTaskbar(true)`, `Tray`, and `app.requestSingleInstanceLock()`) that completely remove the application window from the screen and Windows Taskbar while keeping the Node.js background engine running at full capacity.
2. **Non-Blocking Asynchronous Event Loop:** Simultaneously manages global hardware hooks, in-memory image cropping, multi-item staging queues, `"gemini-3.8-flash"` API requests, and audio playback without freezing the user's active application.
3. **Direct Web Audio API & Hardware Routing:** Enables zero-latency ($\le 5\text{ ms}$) programmatic sound wave synthesis for auditory cues (`tut` earcons), push-to-talk microphone capture, and explicit audio output hardware routing (e.g., locking audio output to a specific headset or earphone) via `AudioContext.setSinkId()`.



### 2.2 Technical Module & Library Specifications

| Functional Layer | Module / Technology | Technical Role in Omniscience |
| --- | --- | --- |
| **Desktop Shell & Lifecycle** | `electron` (Node.js v22 LTS) | Controls the main application window, background process lifecycle, Windows System Tray presence, and Single Instance Lock. |
| **User Interface (UI)** | HTML5 + Vanilla CSS3 + Vanilla JS | Renders the Gemini-inspired chat workspace using CSS Variables, Grid/Flexbox, and BEM architecture without Tailwind CSS. |
| **Vector Icon System** | `lucide-static` (Local SVGs) | Supplies pure `.svg` vector icons for all UI controls, status badges, and System Tray icons (enforcing the Zero-Emoji Policy). |
| **Math & Code Rendering** | `katex` + `highlight.js` | Renders mathematical expressions ($\LaTeX$) and syntax-highlighted code blocks inside the main chat viewport. |
| **Global Input Hooks** | `uiohook-napi` + Native Win32 Hook (`WH_MOUSE_LL`) | Captures system-wide keyboard and mouse states in the background and suppresses the Windows right-click context menu when releasing voice hold. |
| **Screen Frame Capture** | `screenshot-desktop` / `desktopCapturer` | Captures the top-most composite screen frame directly into an in-memory `Buffer` (RAM) with zero screen flicker or visual overlay. |
| **In-Memory Image Processing** | `sharp` | Crops dynamic rectangular regions (`L-CTRL + L-SHIFT`) and compresses screenshots into optimized JPEG buffers in $< 50\text{ ms}$ entirely in RAM. |
| **AI Inference & STT SDK** | `@google/genai` | Connects to `"gemini-3.8-flash"`, configures reasoning depth (`thinkingConfig`), transcribes push-to-talk voice audio, and processes multimodal payloads. |
| **Text-to-Speech (TTS)** | `msedge-tts` | Synthesizes natural English neural speech (`en-US-AndrewNeural` / `en-US-AvaNeural`) into memory buffers with $1.0\times$ and $0.75\times$ playback speed control. |
| **Local Database** | `better-sqlite3` | Stores isolated conversations, rolling summaries, message histories, pruned image descriptions, 8+ API keys, and audio settings in `omniscience.db`. |

### 2.3 Software & Toolchain Required to Build the Application

1. **Visual Studio Code (VS Code):** Primary code editor for JavaScript, C++, HTML5, and Vanilla CSS3.
2. **Node.js (v20 LTS or v22 LTS) & npm:** Runtime and package manager.
3. **Visual Studio Build Tools 2022 (with "Desktop development with C++" workload):** Required by `node-gyp` to compile native C++ modules (`uiohook-napi`, `better-sqlite3`, `sharp`, and the custom `WH_MOUSE_LL` mouse hook addon) into Windows x64 binaries.
4. **Electron Builder (`electron-builder`) & `@electron/rebuild`:** Compiles and packages the source code, native `.node` addons, and `.ico` assets into a standalone `Omniscience.exe` Windows executable.

---

## 3. Main User Interface (UI/UX) & Audio Configuration

The Main Interface replicates the clean, spacious layout of Google Gemini using a custom Vanilla CSS3 design system with Dark Mode (default) and Light Mode support.

### 3.1 Workspace Layout Architecture

1. **Left Navigation Sidebar (Width: $280\text{ px}$, Collapsible):**
* **New Chat Button (SVG icon: `plus`):** Opens a fresh, isolated conversation state with $0\text{ token}$ context memory.
* **Conversation History List:** Lists saved local conversations sorted by `updated_at`. Each item provides inline SVG action buttons to rename (`pencil`) or delete (`trash-2`) the conversation.
* **API Key Pool Indicator:** Displays the real-time status of the 8+ registered API keys (e.g., `8 / 8 Keys Ready`).
* **Settings Button (SVG icon: `sliders`):** Opens the System & Audio Configuration Modal.


2. **Top Header Bar:**
* **Model Identity Badge:** Displays **"Gemini 3.8 Flash"** mapped strictly to `"gemini-3.8-flash"`.
* **Reasoning Level Selector (Segmented Control):** Interactive three-state selector for `Low`, `Medium`, and `High` reasoning levels.
* **Companion Mode Control Button:** Positioned at the top-right corner of the active conversation header featuring a `radar` SVG icon. Clicking this button opens the **Companion Mode Popover**:
* **Companion Sub-Mode Selector:** Radio toggle between **Save Mode** (attaches to the currently open conversation and saves all activity) and **Throw Mode** (stateless, zero-memory execution).
* **Arm Button (`"Activate Companion Standby"`):** Arms the background listener so that closing the window transitions Omniscience into stealth background execution.




3. **Chat Viewport & Multimodal Composer:**
* Displays conversation messages with full Markdown formatting, syntax-highlighted code blocks, and $\LaTeX$ math rendering.
* Supports attaching multiple local files and images via the attachment button (SVG icon: `paperclip`), drag-and-drop, or clipboard paste (`CTRL + V`).
* Automatically logs and displays screenshots, transcribed voice prompts, and AI answers captured during Companion **Save Mode**.


4. **System Settings Modal (API Pool & Audio Controls):**
* **API Key Pool Manager:** Interface to input, remove, and monitor 8 or more Google AI Studio API Keys.
* **Audio Output Device Selector:** Dropdown populated via `navigator.mediaDevices.enumerateDevices()` (`audiooutput`), allowing the user to bind all `tut` earcons and TTS voice playback to a specific connected audio device.
* **Independent Volume Sliders:**
* **Earcon (`Tut`) Volume ($0\% - 100\%$):** Controls the gain of the synthesized confirmation tones.
* **TTS Voice Volume ($0\% - 100\%$):** Controls the playback volume of spoken AI answers.





---

## 4. Context Engineering & Three-Tier Memory Architecture

To match the context retention and token efficiency of production platforms like Gemini, ChatGPT, and Claude, Omniscience implements a **Three-Tier Local Memory Architecture**. Memory is strictly **isolated per `conversation_id**`—creating a new conversation guarantees zero memory carryover.

### 4.1 Three-Tier Context Pipeline

1. **Tier 1 — System Instruction + Asynchronous Rolling Summary ($\le 250\text{ tokens}$):**
* Whenever a conversation exceeds $8$ turns ($16$ messages), older turns pushed out of the active window are summarized asynchronously in the background into a dense paragraph of core facts, active constraints, and defined variables stored in `conversations.rolling_summary`.


2. **Tier 2 — Verbatim Sliding Window (Last $8$ Turns):**
* The most recent $8$ user-model turns are sent verbatim in the `contents` array so `"gemini-3.8-flash"` retains exact mathematical equations, code snippets, and immediate conversational flow.


3. **Tier 3 — Multimodal Image Pruning ($85\%$ Token Quota Saver):**
* Sending historical Base64 screenshots repeatedly on every follow-up turn consumes thousands of tokens unnecessarily.
* In Omniscience, raw image buffers are sent to `"gemini-3.8-flash"` **only on the turn they are submitted**. Once processed, the system records a concise text description of the visual problem in `messages.extracted_image_context`. On subsequent turns within the same conversation, historical image buffers are stripped from the API payload and replaced by their text context summary while remaining visually rendered in the local Chat UI.



### 4.2 Local SQLite Database Schema (`omniscience.db`)

* **Table `conversations`:**
* `id` (`TEXT PRIMARY KEY`) — UUID v4 identifier.
* `title` (`TEXT`) — Conversation title.
* `rolling_summary` (`TEXT`) — Compressed summary of turns older than the $8$-turn sliding window.
* `reasoning_level` (`TEXT`) — `'low' | 'medium' | 'high'`.
* `created_at` (`INTEGER`), `updated_at` (`INTEGER`).


* **Table `messages`:**
* `id` (`TEXT PRIMARY KEY`) — UUID v4 identifier.
* `conversation_id` (`TEXT FOREIGN KEY`) — References `conversations(id) ON DELETE CASCADE`.
* `role` (`TEXT`) — `'user' | 'model'`.
* `content` (`TEXT`) — User prompt / voice transcription or AI response.
* `attachments_json` (`TEXT`) — JSON array of local image paths for UI display.
* `extracted_image_context` (`TEXT`) — Text summary of attached images used for historical turn pruning.
* `created_at` (`INTEGER`).



---

## 5. Multi-API Key Pool & Automatic Failover Engine

To ensure uninterrupted operation across extended problem-solving sessions using 8 (or more) API keys, the `KeyPoolManager` enforces automatic rotation and failover:

1. **Sequential Round-Robin Rotation:**
* All registered API keys are maintained in a circular queue:

$$\text{Index}_{\text{next}} = (\text{Index}_{\text{current}} + 1) \bmod N_{\text{keys}}$$


* Each API call (whether for problem solving or voice transcription) advances to the next `READY` key, distributing Requests Per Minute (RPM) and Tokens Per Minute (TPM) evenly across all 8+ keys.


2. **Instantaneous Zero-Downtime Failover:**
* If key $k$ returns HTTP `429 Too Many Requests` (`ResourceExhausted`) or a quota limit error, `KeyPoolManager` marks key $k$ as `COOLDOWN` (for $60\text{ seconds}$) or `EXHAUSTED_DAILY` and immediately retries the exact same request using key $(k + 1)$ within the same execution cycle.


3. **All-Keys-Exhausted Auditory Alert:**
* If all 8+ keys are simultaneously exhausted, the system plays an error earcon ($3\times$ low-frequency $440\text{ Hz}$ `tut` tones) followed by a pre-synthesized local fallback voice message: *"All API keys have reached their rate limit. Please wait a moment."*



---

## 6. Companion Mode Specification (Stealth Background Agent)

### 6.1 Window Hiding, System Tray Integration, & Re-Launch Handling

1. **Taskbar & Screen Invisibility:**
* When Companion Mode is armed and the user closes the main window, the Electron main process intercepts the `close` event (`event.preventDefault()`), executes `mainWindow.setSkipTaskbar(true)`, and invokes `mainWindow.hide()`.
* The application disappears completely from the screen and the Windows Taskbar while running at full capability in the background.


2. **Windows System Tray Presence:**
* Omniscience registers a clean monochrome vector icon in the **Windows System Tray** so Windows 10/11 recognizes the background daemon as an authorized user utility.
* **System Tray Controls:**
* *Double-Click Tray Icon:* Restores and focuses the main Omniscience window (`mainWindow.setSkipTaskbar(false)` and `mainWindow.show()`).
* *Right-Click Context Menu (Pure Text, Zero Emojis):*
1. `Open Omniscience Workspace`
2. `Companion Status: Active (Save Mode / Throw Mode)`
3. `Reasoning Level: Low / Medium / High`
4. `Quit Omniscience Completely`






3. **Manual `.exe` Re-Launch (`Single Instance Lock`):**
* Omniscience enforces `app.requestSingleInstanceLock()`. If the user launches `Omniscience.exe` while it is already running hidden in Companion Mode, the existing background process catches the `second-instance` event and immediately restores the main window.



### 6.2 Companion Sub-Modes: Save vs. Throw

| Feature / Behavior | Companion Mode: SAVE | Companion Mode: THROW |
| --- | --- | --- |
| **Chat & Database Logging** | All captured screenshots, transcribed voice prompts, and AI answers are saved into the active `conversation_id` and appear in the Chat UI. | **Nothing is written to SQLite or the Chat UI.** All screenshots, transcriptions, and answers exist strictly in volatile RAM and are wiped after TTS playback. |
| **Context & Memory** | Uses the full Three-Tier Context Memory of the active conversation (supports follow-up questions on previous screenshots). | **Zero Memory ($0\text{ Context}$).** Every dispatch (`R-CTRL + Arrow Right`) executes as an isolated, stateless single-turn request. |
| **Dynamic Mode Switching** | Switching from `Throw` back to `Save` via `R-CTRL + Arrow Down` (Hold $1\text{ s}$) automatically reconnects to the **last active conversation**. | Can be toggled dynamically via the UI popover or global keybind whenever the system and AI are `IDLE`. |

### 6.3 Mandatory Companion Mode System Prompt

In Companion Mode, the system prepends the following strict system instruction to `"gemini-3.8-flash"`:

> *"You are operating in One-Way Stealth Companion Mode. The user is sending one or more screenshots along with optional voice-transcribed instructions containing a problem to be solved (Mathematics, Computer Science, Programming, Physics, Science, or Exam Questions). The user cannot view a screen interface and CANNOT reply to your message directly. You must obey these strict rules:*
> *1. Solve the problem shown in the image(s) and text with maximum analytical accuracy.*
> *2. Go straight to the final answer and essential conclusion. Do NOT include greetings, conversational filler, preambles, or improvisation.*
> *3. For multiple-choice questions, state the correct option letter first, followed immediately by the exact answer value and a single concise sentence explaining why.*
> *4. Your response will be read aloud directly by an English Text-to-Speech (TTS) engine. NEVER output raw LaTeX syntax, markdown tables, or unpronounceable symbols. Write all mathematical expressions verbally in clear spoken English (for example, write 'The correct answer is C, negative square root of three over two', NOT 'C. -\frac{\sqrt{3}}{2}')."*

### 6.4 Reasoning Level Mapping (`"gemini-3.8-flash"`)

* **`Low` (Default in Companion Mode):** Configures `"gemini-3.8-flash"` with `thinkingConfig: { thinkingLevel: "LOW" }` for minimum latency on standard questions.
* **`Medium`:** Configures `thinkingConfig: { thinkingLevel: "MEDIUM" }` for multi-step calculations and code tracing.
* **`High`:** Configures `thinkingConfig: { thinkingLevel: "HIGH" }` for complex calculus, linear algebra, discrete mathematics, and advanced algorithmic proofs.

---

## 7. Global Keybinds, Staging Buffer, & OS-Level Mitigations

### 7.1 The Staging Buffer (Multi-Screenshot & Voice Accumulation Queue)

Capturing a screenshot or recording a voice note in Companion Mode **does not immediately trigger an AI request**. Instead, inputs are collected in an in-memory `StagingBuffer`:

* `stagingBuffer.images[]`: Array of compressed JPEG buffers in RAM. Users can combine multiple full-screen captures (`R-CTRL + Arrow Up`) and multiple rectangular region crops (`L-CTRL + L-SHIFT`) for a single problem.
* `stagingBuffer.text`: Concatenated string of English voice transcriptions. When the user holds `Mouse Left + Mouse Right` ($\ge 1\text{ s}$) and releases, the recorded audio is immediately transcribed into text and appended to `stagingBuffer.text`. Holding and releasing again before sending appends the new transcription to the existing staged text.
* The staged payload is only sent to `"gemini-3.8-flash"` when the user presses **`R-CTRL + Arrow Right`**, or completely cleared if the user presses **`R-CTRL + Delete`**.

### 7.2 Programmatic Earcon (`Tut`) Audio Synthesis

All `tut` confirmation tones are synthesized in memory using the Web Audio API (`OscillatorNode` + `GainNode`) with $10\text{ ms}$ fade-in/fade-out envelopes:

* **Standard `Tut` Tone:** $880\text{ Hz}$ Sine Wave (`A5`).
* **Short `Tut`:** Duration = $90\text{ ms}$.
* **Long `Tut`:** Duration = $350\text{ ms}$.
* **Rapid Multi-Tut Interval:** $70\text{ ms}$ silence gap between consecutive tones.


* **Clear / Aborted / Error `Tut` Tone:** $440\text{ Hz}$ Triangle Wave (`A4`), Duration = $110\text{ ms}$.

### 7.3 Complete Global Keybind Specification Table

| Input Combination | Action / Function | Required System State | Technical Execution Details | Auditory `Tut` Feedback |
| --- | --- | --- | --- | --- |
| **`R-CTRL + Arrow Up`** | Capture Full-Screen Screenshot | `IDLE` or `STAGING` | Captures the top-most full screen frame, compresses to JPEG in RAM via `sharp`, and appends to `stagingBuffer.images[]`. Supports multiple captures. | $1\times$ Short `Tut` ($880\text{ Hz}$) |
| **`L-CTRL + L-SHIFT` (Hold $\ge 1000\text{ ms}$, without `R-CTRL`)** | Dynamic Blind Region Screenshot | `IDLE` or `STAGING` | • Holding `L-CTRL + L-SHIFT` for $1\text{ second}$ locks current cursor coordinates as start point $(X_1, Y_1)$ with zero visual overlay.<br>

<br>• User moves the cursor (without clicking) to the opposite corner.<br>

<br>• Releasing the keys locks end point $(X_2, Y_2)$.<br>

<br>• **Validation:** If $ | X_2 - X_1 |
| **`Mouse Left + Mouse Right` (Hold $\ge 1000\text{ ms}$)** | Push-to-Talk Voice Recording & Immediate Transcription | `IDLE` or `STAGING` | • Holding both Left and Right mouse buttons for $1\text{ second}$ starts microphone capture.<br>

<br>• Releasing stops recording automatically, suppresses the Windows right-click context menu, transcribes the audio into English text, and appends it to `stagingBuffer.text`. Repeating appends more text. | • At $1\text{ s}$ hold (start recording): $1\times$ Short `Tut`<br>

<br>• On release (stop recording): $1\times$ Short `Tut` |
| **`R-CTRL + Arrow Right`** | Send All Staged Screenshots & Text to AI | `STAGING` (Buffer not empty) | Dispatches all images in `stagingBuffer.images[]` and text in `stagingBuffer.text` to `"gemini-3.8-flash"`, resets the staging buffer, synthesizes the spoken English answer via TTS, and plays it to the selected audio output device. | $1\times$ Long `Tut` ($350\text{ ms}$) |
| **`R-CTRL + Delete`** | Clear All Staged Text & Images | `STAGING` | Immediately purges all accumulated screenshots (`stagingBuffer.images = []`) and transcribed text (`stagingBuffer.text = ""`), resetting Companion state to `IDLE`. | $2\times$ Low `Tut` ($440\text{ Hz}$) |
| **`R-CTRL + Arrow Left` (Tap $< 500\text{ ms}$)** | Replay Last AI Answer (Normal Speed) | Any State | Replays the cached audio buffer of the most recent AI answer at normal speed ($1.0\times$). | Immediate TTS Audio Replay ($1.0\times$) |
| **`R-CTRL + Arrow Left` (Hold $\ge 500\text{ ms}$)** | Replay Last AI Answer (Slow Speed) | Any State | Replays the cached audio buffer of the most recent AI answer at slow speed ($0.75\times$). | Immediate TTS Audio Replay ($0.75\times$) |
| **`R-CTRL + Arrow Down` (Tap $< 400\text{ ms}$)** | Cycle AI Reasoning Level | Strictly `IDLE` (AI not generating) | Cycles the active reasoning level sequentially: `Low` $\rightarrow$ `Medium` $\rightarrow$ `High` $\rightarrow$ `Low` (default is `Low`). | • `Low`: $1\times$ Short `Tut`<br>

<br>• `Medium`: $2\times$ Rapid Short `Tut`<br>

<br>• `High`: $3\times$ Rapid Short `Tut` |
| **`R-CTRL + Arrow Down` (Hold $\ge 1000\text{ ms}$)** | Toggle Companion Mode (`Save` / `Throw`) | Strictly `IDLE` (AI not generating) | Switches between `Save` and `Throw` modes. Switching from `Throw` to `Save` automatically re-attaches to the last open conversation. | • `Save`: $1\times$ Long `Tut`<br>

<br>• `Throw`: $2\times$ Long `Tut` |

### 7.4 Three OS-Level Input Mitigations

1. **Zero Drag-Selection & Zero Character Typing (`L-CTRL + L-SHIFT`):**
* Using two pure modifier keys (`L-CTRL + L-SHIFT`) with click-free mouse movement guarantees that no text is highlighted, no elements are dragged, and no characters are typed into the active window during the $1\text{ second}$ hold.


2. **Windows Right-Click Context Menu Suppression (`WH_MOUSE_LL` Native C++ Addon):**
* Releasing the right mouse button after holding `Mouse Left + Mouse Right` normally triggers `WM_RBUTTONUP` in Windows, opening a context menu over the active window.
* The custom C++ N-API addon (`mouse_suppressor.cc`) installs a Win32 Low-Level Mouse Hook (`SetWindowsHookEx(WH_MOUSE_LL, ...)`). When `isVoiceRecordingHold === true`, the hook intercepts the next `WM_RBUTTONUP` event and returns `1` (swallowing the event before Windows applications receive it), preventing any context menu from appearing.


3. **Minimum Bounding-Box Validation ($\ge 30\text{ px}$):**
* On releasing `L-CTRL + L-SHIFT`, the capture module calculates:

$$\Delta X = |X_2 - X_1|, \quad \Delta Y = |Y_2 - Y_1|$$


* If $\Delta X < 30\text{ px}$ or $\Delta Y < 30\text{ px}$, the capture is discarded and a $2\times$ low `tut` is played, preventing accidental micro-crops from polluting the staging buffer.



---

## 8. Project Directory & File Architecture

Below is the complete, modular file structure for building **Omniscience**:

* `omniscience/`
* `package.json` — Node.js dependencies, scripts, and build metadata.
* `electron-builder.yml` — Configuration for compiling and packaging the standalone `Omniscience.exe` Windows executable.
* `native-addons/` — Custom Windows C++ Native Addon (Node N-API).
* `binding.gyp` — `node-gyp` build configuration for the MSVC C++ compiler.
* `mouse_suppressor.cc` — Win32 `WH_MOUSE_LL` hook to suppress the right-click context menu on voice recording release.


* `src/`
* `main/` — **ELECTRON MAIN PROCESS (Persistent Background Daemon)**
* `index.js` — Application entry point, Single Instance Lock, and Window lifecycle controller (`hide()` / `setSkipTaskbar(true)`).
* `tray-manager.js` — Windows System Tray icon and emoji-free native context menu controller.
* `ipc-handlers.js` — IPC communication bridge between the Main Process and Renderer UI.
* `companion/` — **Stealth Companion Mode Core Engine**
* `state-machine.js` — Manages states (`IDLE`, `STAGING`, `BUSY`), `Save`/`Throw` mode switching, and `Low`/`Medium`/`High` reasoning levels.
* `staging-buffer.js` — In-memory queue for multi-screenshots and transcribed text, plus `R-CTRL + Delete` purge logic.
* `hook-manager.js` — Global `uiohook-napi` listener, $1\text{ s}$ hold timers, and C++ mouse suppressor trigger.
* `screen-capture.js` — Full-screen capture (`R-CTRL + Arrow Up`) and dynamic region crop (`L-CTRL + L-SHIFT` with $\ge 30\text{ px}$ validation).


* `ai/` — **AI Inference, Voice Transcription, & Context Memory Engine**
* `key-pool.js` — Round-robin rotation for 8+ API keys, `429` cooldown tracking, and instant failover.
* `gemini-service.js` — `"gemini-3.8-flash"` API client wrapper and `thinkingConfig` (`Low`/`Medium`/`High`) controller.
* `memory-engine.js` — Three-tier context builder (Rolling Summary, $8$-Turn Sliding Window, and Multimodal Image Pruning).
* `stt-service.js` — Immediate push-to-talk audio buffer transcription into English text for `stagingBuffer.text`.
* `prompts.js` — System instructions for Standard Chat Mode vs. Stealth Companion Mode.


* `audio/` — **Audio Synthesis & Routing Controller**
* `earcon-synth.js` — Web Audio oscillator generator for $880\text{ Hz}$ and $440\text{ Hz}$ `tut` earcon patterns.
* `tts-engine.js` — English neural TTS synthesis (`msedge-tts`), last-answer RAM audio cache, and $1.0\times$ / $0.75\times$ replay controller.


* `database/` — **Local Persistent Storage (`better-sqlite3`)**
* `sqlite-client.js` — SQLite connection initializer and schema migrations (`omniscience.db`).
* `repositories/`
* `conversation-repo.js` — CRUD for conversations, last active conversation lookup, and Rolling Summary updates.
* `message-repo.js` — CRUD for messages, local image file paths, and pruned image text summaries.
* `settings-repo.js` — Persistent storage for the 8+ API keys, selected audio output `sinkId`, and independent volume levels.






* `preload/`
* `preload.js` — Secure `contextBridge` API exposing IPC channels to the Renderer UI.


* `renderer/` — **MAIN USER INTERFACE (Pure HTML5 / Vanilla CSS3 / Vanilla JS)**
* `index.html` — Main application shell (Zero Tailwind, Zero Emojis).
* `assets/icons/` — Local SVG vector icons from Lucide (`plus.svg`, `radar.svg`, `sliders.svg`, `paperclip.svg`, `send.svg`, `trash-2.svg`, `pencil.svg`, `volume-2.svg`, `key.svg`).
* `styles/` — **Structured Vanilla CSS3 Architecture (BEM + CSS Custom Properties)**
* `variables.css` — Color tokens, typography scales, spacing variables, and Dark/Light theme definitions.
* `layout.css` — CSS Grid and Flexbox layout for the Sidebar, Header, Chat Viewport, and Composer.
* `components.css` — Modular BEM styles for buttons, Companion popover, Settings modal, and syntax-highlighted code blocks.


* `scripts/`
* `app.js` — Main UI controller, conversation switching, and Web Audio `setSinkId()` hardware routing.
* `chat-view.js` — Message renderer, KaTeX math parser, and multi-file attachment preview.
* `companion-ui.js` — Header Companion button, `Save`/`Throw` mode selector popover, and live background sync listener.
* `settings-ui.js` — 8+ API Key pool manager UI, Audio Output Device dropdown, and independent Earcon/TTS volume sliders.






* `build/` — Native Windows icon assets (`icon.ico`, `tray-icon.ico`) for `Omniscience.exe` and the Windows System Tray.