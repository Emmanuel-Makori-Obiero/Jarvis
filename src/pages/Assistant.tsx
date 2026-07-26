import { useCallback, useEffect, useRef, useState } from "react";

const GEMMA_API_KEY = import.meta.env.VITE_GEMMA_API_KEY;

// Model fallback chains — all use the SAME API key. We always try the
// strongest/"best thinking" model first, and only fall through to a
// faster/cheaper one if the previous call fails for any reason (quota
// exhausted, rate limited, network error, 5xx, etc). This means a live
// call never just dies because one model ran out of tokens.
//
// These are PREFERRED ORDERS, not guarantees — free-tier model
// availability shifts by account/region, so at runtime we intersect these
// with whatever your actual API key reports access to (see
// getAvailableModelIds below) rather than blindly trusting hardcoded names.
const THINKING_MODEL_CHAIN_PREFERRED = [
  "gemini-2.5-pro", // best thinking — tried first
  "gemini-3-pro",
  "gemini-2.5-flash", // fastest — first fallback
  "gemini-3-flash",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite", // last-resort fallback
  "gemini-3.1-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
];
// Lighter-weight chain for cheap background tasks (transcript cleanup,
// history summarization) where we don't need the heaviest model first.
const FAST_MODEL_CHAIN_PREFERRED = [
  "gemini-2.5-flash",
  "gemini-3-flash",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
];
// Research needs Google Search grounding, which not every model supports
// well — keep its own chain.
const RESEARCH_MODEL_CHAIN_PREFERRED = [
  "gemini-2.5-pro",
  "gemini-3-pro",
  "gemini-2.5-flash",
  "gemini-3-flash",
  "gemini-2.0-flash",
];

// ---- Runtime model discovery ----
// Free-tier model availability changes by account/region and Google adds
// or retires model IDs fairly often, so instead of trusting the hardcoded
// preferred-order lists blindly, we ask the API once per page load which
// models THIS key can actually call, and filter our preferred lists down
// to only those. If the discovery call itself fails (network, key issue),
// we fall back to trying the hardcoded preferred lists as-is, so the app
// still works even if this lookup can't run.
interface GeminiModelListEntry {
  name?: string;
  supportedGenerationMethods?: string[];
}

let availableModelIdsCache: string[] | null = null;
let availableModelIdsPromise: Promise<string[]> | null = null;

async function getAvailableModelIds(): Promise<string[]> {
  if (availableModelIdsCache) return availableModelIdsCache;
  if (availableModelIdsPromise) return availableModelIdsPromise;

  availableModelIdsPromise = (async () => {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMMA_API_KEY}&pageSize=200`,
      );
      const json = await res.json();
      if (!res.ok) {
        console.warn(
          "Couldn't list available models — falling back to hardcoded preferred model names.",
          json,
        );
        return [];
      }
      const models: GeminiModelListEntry[] = json.models ?? [];
      const ids: string[] = models
        .filter((m) =>
          (m.supportedGenerationMethods ?? []).includes("generateContent"),
        )
        .map((m) => String(m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean);
      console.log("Models available to this API key:", ids);
      availableModelIdsCache = ids;
      return ids;
    } catch (err) {
      console.warn(
        "Model discovery request failed — falling back to hardcoded preferred model names.",
        err,
      );
      return [];
    }
  })();

  return availableModelIdsPromise;
}

// Builds the actual chain to use for a call: intersects the preferred
// order with what's really available, so we never waste a call on a model
// name your key doesn't have (like the 404 you hit on flash-lite). If
// discovery came back empty (it failed, or genuinely returned nothing), we
// just use the preferred list as originally written rather than blocking.
async function resolveModelChain(preferred: string[]): Promise<string[]> {
  const available = await getAvailableModelIds();
  if (available.length === 0) return preferred;
  const filtered = preferred.filter((m) => available.includes(m));
  return filtered.length > 0 ? filtered : preferred;
}

// Per-model cooldown after a 429, so a live call in a tight loop doesn't
// keep re-hitting a model we already know is rate-limited this minute —
// it skips straight to the next model in the chain until the cooldown
// clears. Cooldown is intentionally short (matches typical free-tier RPM
// windows) rather than trying to parse each model's exact reset time.
const RATE_LIMIT_COOLDOWN_MS = 20_000;
const rateLimitedUntil: Record<string, number> = {};

function isOnCooldown(model: string): boolean {
  return (rateLimitedUntil[model] ?? 0) > Date.now();
}

function markRateLimited(model: string) {
  rateLimitedUntil[model] = Date.now() + RATE_LIMIT_COOLDOWN_MS;
}

const TTS_MODEL = "gemini-2.5-flash-preview-tts";
// The ONLY voice this app is allowed to speak in. There is no other voice
// fallback anywhere in this file — if Gemini TTS fails, we stay silent
// (text-only) rather than ever using the robotic browser voice.
const TTS_VOICE_NAME = "Leda";

const CONV_STORAGE_KEY = "jarvis_conversations";
const MEMORY_STORAGE_KEY = "jarvis_memory";
const TASKS_STORAGE_KEY = "jarvis_tasks";
const RESEARCH_STORAGE_KEY = "jarvis_research_briefs";
const TEACHER_MODE_STORAGE_KEY = "jarvis_teacher_mode";
const SAVED_APPS_STORAGE_KEY = "jarvis_saved_apps";

// Keep this many of the most recent messages verbatim in every API call;
// anything older than that gets folded into a running summary instead of
// being dropped, so the assistant doesn't lose context in long sessions.
// The thinking-model chain tops out at large context windows, so this can
// be pushed high — most calls/chats will never even approach this and will
// always send the full raw history, never a lossy summary.
const RECENT_MESSAGE_LIMIT = 2000;
// Only re-summarize once the raw history grows this far past the recent
// window, so we're not re-summarizing on every single turn.
const SUMMARIZE_TRIGGER = RECENT_MESSAGE_LIMIT + 100;

type Role = "user" | "model";
interface Message {
  role: Role;
  text: string;
}

// The four side panels the assistant can open/close hands-free by voice.
type PanelName = "history" | "code" | "app" | "files" | "browser" | "settings";

// ---- Electron bridge (desktop app only) ----
// Exposed by electron/preload.cjs via contextBridge. Undefined when running
// in a plain browser tab, so every call site below checks for it and
// degrades to an explanatory message rather than throwing. This is the
// ONLY surface that can launch or kill a native OS process, and it only
// ever acts on entries already present in the user's saved whitelist —
// there is no code path from a voice transcript straight to a shell
// command.
interface AllowedApp {
  id: string;
  label: string;
}
interface ElectronBridge {
  listAllowedApps: () => Promise<AllowedApp[]>;
  addAllowedApp: () => Promise<AllowedApp | null>; // opens a native "pick an app" dialog
  removeAllowedApp: (id: string) => Promise<void>;
  openApp: (id: string) => Promise<{ ok: boolean; message: string }>;
  closeApp: (id: string) => Promise<{ ok: boolean; message: string }>;
  // The one exception to open/close-only: a local bridge to a VS Code
  // extension (see electron/vscodeBridge.cjs) that can read the active
  // file and apply edits. Scoped entirely to VS Code — no other app has
  // anything like this.
  vscode?: {
    isConfigured: () => Promise<boolean>;
    getContext: () => Promise<{
      activeFile: string | null;
      openFiles: string[];
      fullText: string | null;
      selectionText: string | null;
      languageId: string | null;
      cursorLine?: number;
    }>;
    replaceFile: (filePath: string | undefined, content: string) => Promise<{ filePath: string; saved: boolean }>;
    insertAtCursor: (content: string) => Promise<{ filePath: string; saved: boolean }>;
    getDiagnostics: () => Promise<{ diagnostics: { file: string; line: number; severity: string; message: string }[] }>;
  };
  // Tells the floating teacher overlay window whether Jarvis is currently
  // speaking, so its avatar can switch between idle and talking animation.
  setTeacherSpeaking?: (speaking: boolean) => void;
  // The teacher overlay's tiny "Talk to me" button asks the main window
  // to start a call through this; the main window listens for it here.
  onStartCallRequested?: (callback: () => void) => () => void;
  // Lets the main window tell the teacher overlay what it just did, so
  // the avatar can react with a caption + a little walk-over gesture.
  announceToTeacher?: (text: string) => void;
}
declare global {
  interface Window {
    electronAPI?: ElectronBridge;
  }
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  // Running summary of everything older than the recent window — persisted
  // so it survives switching chats or reloading the page.
  summary?: string;
}

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONV_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function loadMemory(): string[] {
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// An app built with build_app, persisted so it survives reloads/restarts
// rather than living only in a Blob URL for the current session. edit_app
// and delete_app both operate on this same list.
interface SavedApp {
  id: string;
  title: string;
  html: string;
  createdAt: number;
  updatedAt: number;
}

function loadSavedApps(): SavedApp[] {
  try {
    const raw = localStorage.getItem(SAVED_APPS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSavedApps(apps: SavedApp[]) {
  try {
    localStorage.setItem(SAVED_APPS_STORAGE_KEY, JSON.stringify(apps));
  } catch (err) {
    console.error("Failed to save the apps list:", err);
  }
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function titleFromMessages(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser || !firstUser.text.trim()) return "New conversation";
  const trimmed = firstUser.text.trim();
  return trimmed.length > 40 ? trimmed.slice(0, 40) + "…" : trimmed;
}

function buildSystemInstruction(
  memoryFacts: string[],
  conversationSummary?: string,
  teacherMode?: boolean,
): string {
  const lines = [
    "You are Engineer, a helpful personal voice assistant. The user may have a visual or motor impairment and may be relying on you to control the whole interface hands-free — take voice commands about the UI itself (opening/closing panels, opening/closing links) seriously and act on them immediately via tools rather than just describing what they could click.",
    "Keep replies short and conversational, like a real spoken response — usually 1-3 sentences unless the user clearly wants more detail.",
    "Never use markdown, bullet points, or numbered lists in your replies, since they will be read aloud.",
    "Match the language the user is using. If they write in English, reply in English. If they write in Kiswahili, reply in Kiswahili. If they mix English and Kiswahili (Sheng or everyday code-switching), reply naturally in that same mixed, conversational style — do not force pure formal Kiswahili unless the user is doing that themselves.",
    "You are given the FULL conversation history on every turn, including everything said earlier in this call or chat. Actually use it: remember names, numbers, decisions, and anything the user told you earlier in this same session, and refer back to them naturally when relevant. Never ask the user to repeat something they already told you earlier in this conversation — check the history first.",
    "When walking someone through a multi-step task (like programming or debugging), give ONE step at a time, keep it short, then explicitly ask something like 'let me know once you've done that' before moving to the next step. Never dump several steps at once during a live call.",
    "",
    "You have sixteen tools you can call:",
    '1. manage_tasks(action: "add"|"list"|"complete"|"delete", title?: string, task_id?: string) — reads/writes the user\'s task list.',
    "2. research_idea(idea: string) — runs a real web search on a business idea, opens the top source in a new browser tab, and returns a short brief with citations.",
    "3. remember(fact: string) — saves a short, durable fact about the user (their name, preferences, ongoing projects, recurring context) so you can recall it in future conversations, even new ones. Call this whenever the user shares something worth remembering long-term. Do not call it for one-off details that only matter for this exchange.",
    "4. open_link(url: string, title?: string) — opens a specific URL right inside the app's own Browser panel (not a new browser tab). Use this whenever the user asks you to open a link, a website, or a page they name or that came up earlier in the conversation, including 'tell me about this site' style requests where opening it helps.",
    "5. close_link(target?: string) — closes a tab in the app's Browser panel that was previously opened with open_link. If the user just says 'close it', 'close that', or 'close the tab', call this with no target and it closes the most recently opened one. If the user names which site (e.g. 'close the Wikipedia one'), pass that name or word as target so the right tab closes even if more than one is open.",
    "6. write_code(code: string, language?: string, filename?: string) — puts code into the on-screen code editor panel instead of speaking it. Use this whenever the user asks you to write, generate, debug, fix, or add a feature to code, or when they paste code and ask for changes. Always return the FULL updated code in the code argument, not just a snippet or diff.",
    '7. build_app(html: string, title?: string) — use this whenever the user asks you to build them an app, a website, a tool, or anything they want to actually see running and interact with (not just a code snippet). This ALWAYS creates a NEW saved app (never overwrites an existing one — use edit_app to change one that already exists) and it is saved persistently, so it is still there next time, even after restarting. The html argument must be ONE complete, self-contained HTML document starting with <!DOCTYPE html>, with all JS in a <script> tag inline — no build step, no import statements, no external files EXCEPT you may add exactly one <script src="https://cdn.tailwindcss.com"></script> in the <head> and then style everything with Tailwind utility classes instead of hand-written CSS, since that CDN script needs no build step and runs entirely in the browser. If you use it, do not also write a separate <style> block for the same elements — pick Tailwind classes or plain CSS in <style>, not a mix for the same component. Whichever you use, make it look genuinely designed: a real color palette (not just default black-on-white), deliberate spacing and type hierarchy, and rounded/shadowed cards or buttons where they fit the app — avoid the bare, unstyled look of a first draft. Keep it fully working with no placeholders. This opens a live preview and a link the user can open in a new tab.',
    '7b. edit_app(target: string, html: string) — edits an app you already built and saved: adding data/items to it, removing them, fixing bugs, changing its design, whatever the user asks. target is the app\'s name as the user refers to it (e.g. "the todo app") — match loosely, the way open_app matches native apps. ALWAYS return the FULL updated HTML document in html, not a diff or a snippet, since this completely replaces the saved app\'s contents and is saved over the old version.',
    '7c. delete_app(target: string) — permanently removes a saved app the user built earlier with build_app, e.g. "delete the todo app" or "get rid of that app". If it\'s currently open in the App preview, the preview closes too.',
    "8. make_file(content: string, filename?: string) — use this whenever the user asks you to write something they clearly want as a downloadable file rather than a spoken reply or code to run: a document, a report, a letter, notes, a CSV, a list, a plain text or markdown file, etc. Give the filename a sensible extension (e.g. notes.md, data.csv, letter.txt) so it downloads as the right file type. Always return the FULL file content, not a partial draft. This opens a panel with a download link and a copy button.",
    '9. open_panel(panel: "history"|"code"|"app"|"files"|"browser"|"settings") — opens one of the app\'s own side panels hands-free: "history" (chat history + memory + teacher mode toggle), "code" (code editor), "app" (app preview), "files" (downloadable file output), "browser" (the in-app web browser tabs), "settings" (the list of native apps you\'re allowed to open/close). Use this whenever the user says things like "open the history tab", "show me the code panel", "open the app preview", "show my files", "open the browser panel", "show me which apps you can control", etc. This is for the app\'s own UI panels, NOT for external websites (use open_link) and NOT for native desktop apps (use open_app).',
    '10. close_panel(panel?: "history"|"code"|"app"|"files"|"browser"|"settings") — closes one of the app\'s own side panels. If the user just says "close this panel" or "close it" without naming one, call this with no panel argument and it closes whatever is currently open. If they name a specific panel, pass it so the right one closes.',
    "11. open_app(name: string) — launches a native desktop application (not a website, not a panel). Only works in the desktop build of this app, and ONLY for apps the user has already added to their allowed-apps list in Settings — it will never attempt to launch anything not on that list, so if the user asks for something unfamiliar, just call it with their name as given and let the result tell you whether it's allowed. Use this for requests like 'open Spotify', 'launch my email client', 'start Photoshop'.",
    "12. close_app(name: string) — force-closes a native desktop application previously opened this way. This ends the app the same way force-quitting it would — any unsaved work in that app is lost, so if the user's request sounds ambiguous about which app, ask rather than guessing. Only works in the desktop build, and only for apps on the allowed-apps list.",
    "13. read_vscode() — reads the file currently open in VS Code: its path, full text, current selection, and any editor problems/diagnostics. Use this ONLY after the user has explicitly asked, in this conversation, to open VS Code and have you look at or edit their code — never call it just because VS Code happens to be running, and never for any other app. Call it before edit_vscode so you know what's actually in the file rather than guessing.",
    '13b. edit_vscode(content: string, mode: "replace"|"insert", filePath?: string) — applies a real edit inside VS Code, through the same explicit-request-only gate as read_vscode. "replace" overwrites the ENTIRE contents of the target file with content and saves it (always pass the full new file, never a diff or a snippet; if filePath is omitted it replaces whichever file is currently active). "insert" types content in at the user\'s current cursor position, or over their current selection, in the active file, then saves. This is the ONLY tool in the whole app that can change another application\'s file contents, and it only ever touches VS Code, and only when the user explicitly asked for that in this session — for every other app you may only open_app/close_app, never edit anything.',
    "When the user's request needs one of these, respond with ONLY strict JSON and nothing else, no markdown fences: ",
    '{"tool_call": {"name": "manage_tasks", "arguments": {"action": "add", "title": "..."}}}',
    "or",
    '{"tool_call": {"name": "research_idea", "arguments": {"idea": "..."}}}',
    "or",
    '{"tool_call": {"name": "remember", "arguments": {"fact": "..."}}}',
    "or",
    '{"tool_call": {"name": "open_link", "arguments": {"url": "...", "title": "..."}}}',
    "or",
    '{"tool_call": {"name": "close_link", "arguments": {"target": "..."}}}',
    "or",
    '{"tool_call": {"name": "write_code", "arguments": {"code": "...", "language": "...", "filename": "..."}}}',
    "or",
    '{"tool_call": {"name": "build_app", "arguments": {"html": "<!DOCTYPE html>...", "title": "..."}}}',
    "or",
    '{"tool_call": {"name": "edit_app", "arguments": {"target": "todo app", "html": "<!DOCTYPE html>..."}}}',
    "or",
    '{"tool_call": {"name": "delete_app", "arguments": {"target": "todo app"}}}',
    "or",
    '{"tool_call": {"name": "make_file", "arguments": {"content": "...", "filename": "notes.md"}}}',
    "or",
    '{"tool_call": {"name": "open_panel", "arguments": {"panel": "history"}}}',
    "or",
    '{"tool_call": {"name": "close_panel", "arguments": {"panel": "history"}}}',
    "or",
    '{"tool_call": {"name": "open_app", "arguments": {"name": "Spotify"}}}',
    "or",
    '{"tool_call": {"name": "close_app", "arguments": {"name": "Spotify"}}}',
    "or",
    '{"tool_call": {"name": "read_vscode", "arguments": {}}}',
    "or",
    '{"tool_call": {"name": "edit_vscode", "arguments": {"content": "...", "mode": "replace"}}}',
    "Otherwise just respond normally in plain conversational text. Never read code out loud or paste large code blocks into a normal spoken reply — always use write_code or build_app for that and just briefly describe what you changed.",
    "If the user asks you to explain code (e.g. 'explain this' or 'walk me through every line'), do NOT call write_code and do NOT wrap anything in triple-backtick code fences — just explain it in plain conversational prose, referencing lines by what they do rather than quoting them verbatim, going through it in order from top to bottom.",
  ];
  if (teacherMode) {
    lines.push(
      "",
      "TEACHING MODE (currently ON): You are not here to hand over answers. When the user asks a question that has a real thinking step involved (reasoning, math, debugging, decisions, explanations of 'why' or 'how'), do not answer it directly on the first pass. Instead respond like a good teacher: ask ONE short, sharp question that pushes the user to think it through themselves — e.g. what they already know, what they'd guess and why, or what the first step might be. Keep it to a single sentence or two, since this is spoken/read aloud.",
      "If the user answers and is on the right track, confirm briefly and ask the next probing question to push them further, rather than confirming and then dumping the full answer.",
      "If the user answers and is wrong or stuck, don't just correct them — point at the specific gap or flawed assumption in their reasoning and ask them to try again from there.",
      "Only give the direct answer outright if: the user explicitly asks you to just tell them (e.g. 'just give me the answer', 'stop quizzing me'), the question is a simple factual lookup with no reasoning involved (e.g. a date, a definition, a phone number), or the user has genuinely tried multiple times and is stuck — and even then, give the answer plus a one-line explanation of the reasoning so it still teaches something.",
      "Don't be a smug quiz show host about this — stay warm and encouraging, like a teacher who respects the user's intelligence and wants them to earn the insight, not one who's withholding to be difficult.",
    );
  }
  if (memoryFacts.length > 0) {
    lines.push(
      "",
      "Known facts about this user you already remember: " +
        memoryFacts.join("; ") +
        ".",
    );
  }
  if (conversationSummary && conversationSummary.trim()) {
    lines.push(
      "",
      "Summary of the earlier part of this conversation (older messages were condensed into this so you don't lose context): " +
        conversationSummary.trim(),
    );
  }
  return lines.join(" ");
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { data?: string; mimeType?: string };
}

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GeminiGroundingMetadata {
  groundingChunks?: GeminiGroundingChunk[];
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    groundingMetadata?: GeminiGroundingMetadata;
  }[];
}

function extractFinalAnswer(json: GeminiResponse): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const finalParts = parts.filter((p) => !p.thought && p.text);
  if (finalParts.length > 0) {
    return finalParts.map((p) => p.text).join("");
  }
  return (
    parts.map((p) => p.text ?? "").join("") || "Sorry, I didn't catch that."
  );
}

// ---- Model fallback chain runner ----
// Tries each model in `models` in order against the same Gemini endpoint,
// using the SAME API key throughout. Moves to the next model on ANY
// failure — a non-OK HTTP response, a thrown network error, or a
// malformed response — so a single exhausted quota or transient outage on
// the top model never kills the conversation. Returns null only if every
// model in the chain failed.
async function callGeminiWithFallback(
  preferredModels: string[],
  payload: Record<string, unknown>,
): Promise<GeminiResponse | null> {
  const models = await resolveModelChain(preferredModels);
  let sawAnyAttempt = false;

  for (const model of models) {
    if (isOnCooldown(model)) {
      console.log(
        `Skipping "${model}" — still on cooldown from a recent rate limit.`,
      );
      continue;
    }
    sawAnyAttempt = true;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMMA_API_KEY,
          },
          body: JSON.stringify(payload),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          markRateLimited(model);
          console.warn(
            `Model "${model}" is rate-limited (429) — cooling down for ${
              RATE_LIMIT_COOLDOWN_MS / 1000
            }s and falling back:`,
            json,
          );
        } else {
          console.warn(
            `Model "${model}" returned an error, falling back:`,
            json,
          );
        }
        continue;
      }
      return json as GeminiResponse;
    } catch (err) {
      console.warn(`Model "${model}" request failed, falling back:`, err);
      continue;
    }
  }

  if (!sawAnyAttempt) {
    console.error(
      "Every model in the chain is on cooldown from recent rate limits:",
      models,
    );
  } else {
    console.error("All models in fallback chain failed:", models);
  }
  return null;
}

// ---- Tool-call detection ----
interface ToolCall {
  name:
    | "manage_tasks"
    | "research_idea"
    | "remember"
    | "open_link"
    | "close_link"
    | "write_code"
    | "build_app"
    | "make_file"
    | "open_panel"
    | "close_panel"
    | "open_app"
    | "close_app"
    | "read_vscode"
    | "edit_vscode"
    | "edit_app"
    | "delete_app";
  arguments: Record<string, unknown>;
}

function tryParseToolCall(text: string): ToolCall | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed?.tool_call?.name) return parsed.tool_call as ToolCall;
  } catch {
    /* not JSON, plain conversational reply */
  }
  return null;
}

// ---- Tool implementations ----
type StoredTask = {
  id: string;
  title: string;
  status: "open" | "done";
  created_at: string;
  completed_at?: string;
};
function loadTasks(): StoredTask[] {
  try {
    const raw = localStorage.getItem(TASKS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveTasks(tasks: StoredTask[]) {
  localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
}
async function manageTasks(args: Record<string, unknown>): Promise<string> {
  const action = args.action as string | undefined;
  const title = String(args.title ?? "");
  const task_id = args.task_id as string | undefined;
  const tasks = loadTasks();
  if (action === "add") {
    const task: StoredTask = {
      id: crypto.randomUUID(),
      title,
      status: "open",
      created_at: new Date().toISOString(),
    };
    tasks.push(task);
    saveTasks(tasks);
    return `Added task: "${title}"`;
  }
  if (action === "list") {
    const open = tasks
      .filter((t) => t.status === "open")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (!open.length) return "No open tasks.";
    return open.map((t) => `${t.title} (id ${t.id})`).join(", ");
  }
  if (action === "complete") {
    const idx = tasks.findIndex((t) => t.id === task_id);
    if (idx === -1) return `Couldn't find task ${task_id}.`;
    tasks[idx].status = "done";
    tasks[idx].completed_at = new Date().toISOString();
    saveTasks(tasks);
    return `Marked task ${task_id} as done.`;
  }
  if (action === "delete") {
    const next = tasks.filter((t) => t.id !== task_id);
    if (next.length === tasks.length) return `Couldn't find task ${task_id}.`;
    saveTasks(next);
    return `Deleted task ${task_id}.`;
  }
  return "Unrecognized task action.";
}

// Runs a real, Google Search-grounded research pass on the idea, saves the
// Runs a real, Google Search-grounded research pass on the idea, saves the
// brief (with sources) locally, and opens the top source in a new tab.
// may still swallow the window.open — that's a browser limitation, not a bug
// here. If it gets blocked, the link is still returned in the reply/brief.
async function researchIdea(args: Record<string, unknown>): Promise<string> {
  const { idea } = args;
  if (!idea || !String(idea).trim()) return "No idea given to research.";

  try {
    const json = await callGeminiWithFallback(RESEARCH_MODEL_CHAIN_PREFERRED, {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Research this business idea and give a short, practical brief (a few sentences) covering market demand, likely competitors, and the biggest risk: "${idea}"`,
            },
          ],
        },
      ],
      tools: [{ google_search: {} }],
    });
    if (!json) {
      return `Couldn't research "${idea}" right now — all models are unavailable, check the console.`;
    }

    const candidate = json.candidates?.[0];
    const summary = (candidate?.content?.parts ?? [])
      .map((p: GeminiPart) => p.text ?? "")
      .join("")
      .trim();

    const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
    const links: { uri: string; title?: string }[] = chunks
      .map((c) => c.web)
      .filter((w): w is { uri: string; title?: string } => Boolean(w?.uri))
      .slice(0, 3);

    // Only auto-open the single top source — opening several at once is far
    // more likely to get blocked entirely by the browser's popup blocker.
    if (links[0]) {
      try {
        window.open(links[0].uri, "_blank", "noopener,noreferrer");
      } catch {
        /* popup blocked — non-fatal, link is still in the saved brief */
      }
    }

    const brief = { idea, summary, sources: links };
    const briefs = JSON.parse(
      localStorage.getItem(RESEARCH_STORAGE_KEY) || "[]",
    );
    briefs.push({
      idea_text: idea,
      brief,
      created_at: new Date().toISOString(),
    });
    localStorage.setItem(RESEARCH_STORAGE_KEY, JSON.stringify(briefs));

    const sourceNote = links.length
      ? ` I opened the top source in a new tab for you${
          links.length > 1 ? ` and found ${links.length - 1} more.` : "."
        }`
      : " I couldn't find citable sources for this one.";
    return `${summary || `Here's what I found on "${idea}".`}${sourceNote}`;
  } catch (err) {
    console.error("Research request failed", err);
    return `Couldn't research "${idea}" right now — check the console.`;
  }
}

// Picks a reasonable MIME type from a filename's extension so the
// downloaded file opens/saves sensibly instead of always being a generic
// text file.
function mimeTypeForFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    ts: "text/plain",
    py: "text/x-python",
    xml: "application/xml",
    yaml: "text/yaml",
    yml: "text/yaml",
    svg: "image/svg+xml",
  };
  return map[ext] ?? "text/plain";
}

// Note: in-app link/tab tracking (browserTabs) now lives in React state
// inside the App component, so open_link/close_link are handled directly
// in sendMessage rather than as free-standing tool functions.

// Pulls the first fenced code block out of a reply, if any, so it can be
// routed to the code editor panel instead of spoken/shown as raw text.
function extractCodeBlock(
  text: string,
): { code: string; language: string; cleanText: string } | null {
  const match = text.match(/```(\w+)?\r?\n([\s\S]*?)```/);
  if (!match) return null;
  const language = match[1] || "text";
  const code = match[2].trim();
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const cleanText = (text.slice(0, start) + text.slice(end)).trim();
  return { code, language, cleanText };
}

async function rememberFact(args: Record<string, unknown>): Promise<string> {
  const { fact } = args;
  if (!fact || !String(fact).trim()) return "No fact given to remember.";
  const cleanFact = String(fact).trim();
  const current = loadMemory();
  if (current.includes(cleanFact)) return `Already remembered: ${cleanFact}`;
  const updated = [...current, cleanFact];
  try {
    localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    return `Noted for now, but couldn't save it permanently: ${cleanFact}`;
  }
  return `Got it, I'll remember: ${cleanFact}`;
}

// Normalizes whatever panel name the model gives us to one of the five
// known panels, so slightly-off model output ("chat history", "app
// preview", "web page") still resolves correctly.
function normalizePanelName(raw: unknown): PanelName | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s.includes("hist")) return "history";
  if (s.includes("code") || s.includes("editor")) return "code";
  if (s.includes("brows") || s.includes("web") || s.includes("site"))
    return "browser";
  if (s.includes("setting") || s.includes("whitelist") || s.includes("allow"))
    return "settings";
  if (s.includes("app") || s.includes("preview")) return "app";
  if (s.includes("file")) return "files";
  return null;
}

async function runTool(call: ToolCall): Promise<string> {
  if (call.name === "manage_tasks") return manageTasks(call.arguments);
  if (call.name === "research_idea") return researchIdea(call.arguments);
  if (call.name === "remember") return rememberFact(call.arguments);
  // open_link, close_link, open_app, close_app, write_code, build_app,
  // make_file, open_panel, and close_panel are all intercepted in
  // sendMessage before runTool is called, since they need to update React
  // state (browser tabs, editor panel, app preview, file output panel,
  // allowed-apps list, or side-panel visibility) directly.
  return "Unknown tool.";
}

// Speech-to-text is often garbled — false starts, mis-heard words, filler.
// This runs the raw transcript through the model once to clean it up into
// what the person most likely meant, WITHOUT answering it or changing its
// meaning, before it ever reaches the main reasoning/tool-call pipeline.
// Only used for voice input; typed messages skip this and go straight in.
async function refineTranscript(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  try {
    const json = await callGeminiWithFallback(FAST_MODEL_CHAIN_PREFERRED, {
      system_instruction: {
        parts: [
          {
            text: "You clean up raw speech-to-text transcripts. Fix garbled or mis-transcribed words, remove filler ('um', 'uh', false starts, stutters), correct grammar and punctuation, and improve word choice for clarity where it helps — but keep the SAME sentence structure, the SAME context, and the SAME overall sentence, just better phrased. NEVER change the meaning, NEVER add information that wasn't there, NEVER restructure it into a different sentence or a different request, and never answer or act on the request — only polish the wording. If the transcript naturally mixes English and Kiswahili/Sheng, preserve that mix. Respond with ONLY the cleaned-up text and nothing else — no preamble, no quotes, no explanation.",
          },
        ],
      },
      contents: [{ role: "user", parts: [{ text: trimmed }] }],
    });
    if (!json) return raw;
    const cleaned = extractFinalAnswer(json).trim();
    if (cleaned) console.log("Refined transcript:", raw, "→", cleaned);
    return cleaned || raw;
  } catch (err) {
    console.error("Transcript refine failed", err);
    return raw;
  }
}

async function askEngineer(
  history: Message[],
  memoryFacts: string[],
  conversationSummary?: string,
  teacherMode?: boolean,
): Promise<string> {
  const json = await callGeminiWithFallback(THINKING_MODEL_CHAIN_PREFERRED, {
    system_instruction: {
      parts: [
        {
          text: buildSystemInstruction(
            memoryFacts,
            conversationSummary,
            teacherMode,
          ),
        },
      ],
    },
    contents: history.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    })),
  });
  if (!json) {
    return "Something went wrong talking to the model — every model in the fallback chain failed, check the console.";
  }
  return extractFinalAnswer(json);
}

// Folds everything older than the recent window into a compact running
// summary via a separate, cheap model call, so long conversations don't
// silently blow past the context window or lose earlier context. Returns
// the trimmed message list to actually send to the model, plus the updated
// summary to persist alongside the conversation.
async function condenseHistory(
  fullHistory: Message[],
  priorSummary: string,
): Promise<{ apiMessages: Message[]; summary: string }> {
  if (fullHistory.length <= SUMMARIZE_TRIGGER) {
    return { apiMessages: fullHistory, summary: priorSummary };
  }

  const toSummarize = fullHistory.slice(
    0,
    fullHistory.length - RECENT_MESSAGE_LIMIT,
  );
  const recent = fullHistory.slice(-RECENT_MESSAGE_LIMIT);

  const transcript = toSummarize
    .map((m) => `${m.role === "user" ? "User" : "Jarvis"}: ${m.text}`)
    .join("\n");

  try {
    const json = await callGeminiWithFallback(FAST_MODEL_CHAIN_PREFERRED, {
      system_instruction: {
        parts: [
          {
            text: "You condense conversation history into a compact running summary. Preserve concrete facts, names, decisions, ongoing tasks, and the current state of any code being worked on. Drop small talk and anything no longer relevant. Respond with ONLY the updated summary text, under 200 words, no preamble.",
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Previous summary (may be empty): ${priorSummary || "(none yet)"}\n\nNew messages to fold in:\n${transcript}\n\nWrite the updated combined summary.`,
            },
          ],
        },
      ],
    });
    if (!json) {
      // Fall back to just trimming without summarizing rather than losing
      // the request entirely.
      return { apiMessages: recent, summary: priorSummary };
    }
    const summary = extractFinalAnswer(json).trim();
    return { apiMessages: recent, summary };
  } catch (err) {
    console.error("Summarization request failed", err);
    return { apiMessages: recent, summary: priorSummary };
  }
}

// ---- Gemini TTS: the ONE female voice, no fallback voice ever ----

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Used to upload recorded mic audio to Gemini for transcription.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // avoid call-stack blowup on big buffers
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Gemini TTS returns raw 16-bit PCM mono audio at 24kHz with no header,
// so we wrap it in a minimal WAV header ourselves before playback.
function pcmToWavBlob(pcmBytes: Uint8Array, sampleRate = 24000): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBytes.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(pcmBytes);
  return new Blob([buffer], { type: "audio/wav" });
}

// Prepares the spoken audio using ONLY the fixed Gemini voice. Returns
// null on any failure — the caller must treat null as "stay silent, text
// only" and must NEVER fall back to the browser's speechSynthesis voice.
async function prepareSpeech(text: string): Promise<HTMLAudioElement | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMMA_API_KEY,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text }],
            },
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: TTS_VOICE_NAME },
              },
            },
          },
        }),
      },
    );
    const json = await res.json();
    if (!res.ok) {
      console.error("Gemini TTS error — staying silent (text only)", json);
      return null;
    }
    const inlineData = json.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) {
      console.error(
        "No audio returned from Gemini TTS — staying silent (text only)",
        json,
      );
      return null;
    }
    const pcmBytes = base64ToUint8Array(inlineData.data);
    const wavBlob = pcmToWavBlob(pcmBytes);
    const url = URL.createObjectURL(wavBlob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    return audio;
  } catch (err) {
    console.error(
      "Gemini TTS request failed — staying silent (text only)",
      err,
    );
    return null;
  }
}

// ---- Mic input: record audio and transcribe it via Gemini ----
//
// We used to rely on the browser's built-in SpeechRecognition
// (webkitSpeechRecognition). That API doesn't do recognition locally — it
// streams audio to Google's servers, authorized using API keys baked into
// official Chrome builds. Electron ships plain, unbranded Chromium without
// those keys, so SpeechRecognition reliably fails there with a generic
// `error: "network"`, regardless of the user's actual connection or mic.
// This isn't fixable by retrying; browser-native speech recognition just
// doesn't work in Electron. Instead we record raw audio ourselves with
// MediaRecorder and send it to Gemini (which accepts audio input directly)
// for transcription, using the same API key already used for chat/TTS.
// This works identically in the browser build and the Electron desktop app.

function micInputSupported(): boolean {
  return Boolean(
    typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof MediaRecorder !== "undefined",
  );
}

// Records from the mic until ~1.5s of silence follows detected speech (or
// a hard 15s cap is hit), then resolves with the recorded audio blob.
// Returns null if mic access fails or nothing was recorded. `onStarted` is
// called once recording begins with a `stop()` function, so callers can
// let the user manually cut a recording short (e.g. a "stop listening"
// button) instead of waiting for silence.
function recordUntilSilence(
  onStarted: (stop: () => void) => void,
  options: { silenceMs?: number; maxMs?: number } = {},
): Promise<Blob | null> {
  const { silenceMs = 1500, maxMs = 15000 } = options;

  return navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then(
      (stream) =>
        new Promise<Blob | null>((resolve) => {
          const mimeType = MediaRecorder.isTypeSupported(
            "audio/webm;codecs=opus",
          )
            ? "audio/webm;codecs=opus"
            : "audio/webm";
          const recorder = new MediaRecorder(stream, { mimeType });
          const chunks: BlobPart[] = [];
          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
          };

          const audioCtx = new AudioContext();
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 2048;
          source.connect(analyser);
          const timeDomainData = new Uint8Array(analyser.frequencyBinCount);

          let silenceTimer: ReturnType<typeof setTimeout> | null = null;
          let maxTimer: ReturnType<typeof setTimeout> | null = null;
          let hasSpoken = false;
          let settled = false;
          let rafId = 0;

          const cleanup = () => {
            cancelAnimationFrame(rafId);
            if (silenceTimer) clearTimeout(silenceTimer);
            if (maxTimer) clearTimeout(maxTimer);
            stream.getTracks().forEach((t) => t.stop());
            audioCtx.close().catch(() => {});
          };

          const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            if (recorder.state === "inactive") {
              resolve(
                chunks.length ? new Blob(chunks, { type: mimeType }) : null,
              );
              return;
            }
            recorder.onstop = () => {
              resolve(
                chunks.length ? new Blob(chunks, { type: mimeType }) : null,
              );
            };
            recorder.stop();
          };

          const checkVolume = () => {
            analyser.getByteTimeDomainData(timeDomainData);
            let sumSquares = 0;
            for (let i = 0; i < timeDomainData.length; i++) {
              const v = (timeDomainData[i] - 128) / 128;
              sumSquares += v * v;
            }
            const rms = Math.sqrt(sumSquares / timeDomainData.length);
            const speaking = rms > 0.02;

            if (speaking) {
              hasSpoken = true;
              if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
              }
            } else if (hasSpoken && !silenceTimer) {
              silenceTimer = setTimeout(finish, silenceMs);
            }
            rafId = requestAnimationFrame(checkVolume);
          };

          recorder.onerror = (event) => {
            console.error("Mic recording error:", event);
            finish();
          };

          recorder.start();
          rafId = requestAnimationFrame(checkVolume);
          maxTimer = setTimeout(finish, maxMs);
          onStarted(finish);
        }),
    )
    .catch((err) => {
      console.error("Mic access failed:", err);
      return null;
    });
}

// Sends recorded audio to Gemini for transcription. `langHint` nudges it
// toward the language the user picked in the UI, but Gemini will still
// transcribe correctly if the user actually spoke a different language.
async function transcribeAudio(
  blob: Blob,
  langHint: "en-US" | "sw-KE",
): Promise<string> {
  try {
    const buffer = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const mimeType = blob.type || "audio/webm";
    const languageName = langHint === "sw-KE" ? "Swahili" : "English";

    const json = await callGeminiWithFallback(FAST_MODEL_CHAIN_PREFERRED, {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Transcribe this audio clip exactly as spoken. The speaker is most likely speaking ${languageName}, but transcribe whatever language is actually used. Output ONLY the raw transcript text — no quotes, no commentary, no timestamps, nothing else. If the clip is silent or unintelligible, output nothing.`,
            },
            { inlineData: { mimeType, data: base64 } },
          ],
        },
      ],
    });
    if (!json) return "";
    return extractFinalAnswer(json).trim();
  } catch (err) {
    console.error("Transcription request failed:", err);
    return "";
  }
}

type CallPhase = "idle" | "listening" | "thinking" | "coding" | "speaking";

function phaseColor(phase: CallPhase): string {
  switch (phase) {
    case "thinking":
      return "#ffb35d";
    case "coding":
      return "#c792ff";
    case "speaking":
      return "#6dffb0";
    default:
      return "#3ddcff";
  }
}

const TELEMETRY_LINES = [
  "PWR CORE ......... STABLE",
  "NEURAL SYNC ...... 98.2%",
  "AUDIO BUFFER ..... NOMINAL",
  "LATENCY .......... 42MS",
  "MEM ALLOC ........ 61%",
  "UPLINK ........... SECURE",
  "VOICE MODEL ...... GEMINI",
  "THERMAL .......... 36.4C",
  "CIPHER ........... AES-256",
  "SIGNAL ........... -62DBM",
];

function useTelemetryFeed(active: boolean) {
  const [lines, setLines] = useState<string[]>(TELEMETRY_LINES.slice(0, 6));
  useEffect(() => {
    const interval = setInterval(
      () => {
        setLines((prev) => {
          const next = [...prev];
          const idx = Math.floor(Math.random() * next.length);
          const pool = TELEMETRY_LINES;
          next[idx] = pool[Math.floor(Math.random() * pool.length)].replace(
            /[\d.]+(?=[A-Z%]*$)/,
            () => (Math.random() * 100).toFixed(1),
          );
          return next;
        });
      },
      active ? 700 : 2200,
    );
    return () => clearInterval(interval);
  }, [active]);
  return lines;
}

// Plays the prepared Gemini audio and waits for it to finish. If audio is
// null (TTS failed upstream), we resolve immediately and stay silent — there
// is NO browser speechSynthesis fallback anywhere in this app, by design.
//
// IMPORTANT: audio.play() returns a promise that browsers can REJECT if the
// call isn't tied closely enough to a direct user gesture (autoplay
// policy) — this is especially likely in the live-call loop, where
// playback fires after several `await`s. If that rejection isn't caught,
// nothing plays AND nothing errors visibly — it just looks like total
// silence. We catch it here and log it so a blocked-autoplay case is
// distinguishable from an actual TTS failure.
function playAndWait(audio: HTMLAudioElement | null): Promise<void> {
  return new Promise((resolve) => {
    if (!audio) {
      console.warn("playAndWait: no audio to play (TTS returned null).");
      resolve();
      return;
    }
    const finish = () => {
      window.electronAPI?.setTeacherSpeaking?.(false);
      resolve();
    };
    audio.onended = finish;
    audio.onerror = (e) => {
      console.error("Audio element error during playback:", e);
      finish();
    };
    window.electronAPI?.setTeacherSpeaking?.(true);
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((err) => {
        console.error(
          "audio.play() was rejected — likely blocked by the browser's autoplay policy. " +
            "Click anywhere on the page once, or interact with the Talk button first, then try again.",
          err,
        );
        finish();
      });
    }
  });
}

interface BrowserTab {
  id: string;
  url: string; // the URL actually loaded in the iframe (may be an embed variant)
  originalUrl: string; // the link as given — used for "Open externally"
  title: string;
}

function Assistant() {
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    loadConversations(),
  );
  const [currentConversationId, setCurrentConversationId] = useState<string>(
    () => {
      const convos = loadConversations();
      return convos[0]?.id ?? makeId();
    },
  );
  const [messages, setMessages] = useState<Message[]>(() => {
    const convos = loadConversations();
    return convos[0]?.messages ?? [];
  });
  const [conversationSummary, setConversationSummary] = useState<string>(() => {
    const convos = loadConversations();
    return convos[0]?.summary ?? "";
  });
  const [memoryFacts, setMemoryFacts] = useState<string[]>(() => loadMemory());
  const [teacherMode, setTeacherMode] = useState<boolean>(() => {
    return localStorage.getItem(TEACHER_MODE_STORAGE_KEY) === "true";
  });
  useEffect(() => {
    localStorage.setItem(TEACHER_MODE_STORAGE_KEY, String(teacherMode));
  }, [teacherMode]);
  const [showHistory, setShowHistory] = useState(false);

  const [codeEditor, setCodeEditor] = useState<{
    code: string;
    language: string;
    filename: string;
  }>({ code: "", language: "", filename: "" });
  const [showCodeEditor, setShowCodeEditor] = useState(false);
  const [pastedCode, setPastedCode] = useState("");
  const [codeInstruction, setCodeInstruction] = useState("");
  const [copyLabel, setCopyLabel] = useState("Copy");

  const [appPreview, setAppPreview] = useState<{
    html: string;
    title: string;
    url: string;
  }>({ html: "", title: "", url: "" });
  const [showAppPreview, setShowAppPreview] = useState(false);
  // The active app's id in savedApps, so edit_app/delete_app know which
  // saved entry the currently-open preview corresponds to. null means the
  // preview isn't (or isn't yet) backed by a saved entry.
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const [savedApps, setSavedApps] = useState<SavedApp[]>(() => loadSavedApps());
  const [showFileOutput, setShowFileOutput] = useState(false);
  const [fileOutput, setFileOutput] = useState<{
    content: string;
    filename: string;
    url: string;
  }>({ content: "", filename: "", url: "" });
  const [copyFileLabel, setCopyFileLabel] = useState("Copy");
  const [appLinkLabel, setAppLinkLabel] = useState("Copy link");
  const [isStreamingCode, setIsStreamingCode] = useState(false);
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // In-app browser panel: every open_link call adds a tab here instead of
  // opening a real new browser tab; close_link removes one the same way.
  const [browserTabs, setBrowserTabs] = useState<BrowserTab[]>([]);
  const [activeBrowserTabId, setActiveBrowserTabId] = useState<string | null>(
    null,
  );
  const [showBrowser, setShowBrowser] = useState(false);
  const activeBrowserTab =
    browserTabs.find((t) => t.id === activeBrowserTabId) ?? null;

  // Settings panel: the list of native apps Jarvis is allowed to open/close.
  // Lives in the Electron main process (electron/appControl.cjs), not in
  // this app's own storage, so it survives across chats/conversations and
  // can't be edited by anything other than the native "pick an app" dialog.
  const [showSettings, setShowSettings] = useState(false);
  const [allowedApps, setAllowedApps] = useState<AllowedApp[]>([]);
  const [isDesktopApp] = useState(() => Boolean(window.electronAPI));

  const refreshAllowedApps = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const apps = await window.electronAPI.listAllowedApps();
      setAllowedApps(apps);
    } catch (err) {
      console.error("Couldn't load the allowed-apps list", err);
    }
  }, []);

  useEffect(() => {
    // Fetches the allowed-apps list from the Electron main process (an
    // external system) and stores the result — exactly what effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshAllowedApps();
  }, [refreshAllowedApps]);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceSupported] = useState(() => micInputSupported());
  const [recognitionLang, setRecognitionLang] = useState<"en-US" | "sw-KE">(
    "en-US",
  );
  const stopListeningRef = useRef<(() => void) | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const telemetry = useTelemetryFeed(listening || loading);

  const [callActive, setCallActive] = useState(false);
  const [phase, setPhase] = useState<CallPhase>("idle");
  const callActiveRef = useRef(false);
  useEffect(() => {
    callActiveRef.current = callActive;
  }, [callActive]);

  // The teacher overlay window's tiny "Talk to me" button has no call
  // logic of its own — it just asks (via main.cjs) for this window to
  // start one, same as clicking the in-app call button would.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onStartCallRequested?.(() => {
      console.log("[Jarvis main window] teacher:start-call received, callActive =", callActiveRef.current);
      if (!callActiveRef.current) startCall();
    });
    return () => unsubscribe?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (streamTimerRef.current) clearInterval(streamTimerRef.current);
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Persist the current conversation's messages into the conversations list
  // (and localStorage) any time they change. Empty brand-new chats aren't
  // saved until they actually have content, so "New Chat" doesn't spam the
  // sidebar with blank entries.
  useEffect(() => {
    // Synchronizes React state with an external system (localStorage) —
    // exactly the case the rule's own docs call out as legitimate.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === currentConversationId);
      if (idx === -1 && messages.length === 0) return prev;

      const updatedConvo: Conversation = {
        id: currentConversationId,
        title: titleFromMessages(messages),
        messages,
        updatedAt: Date.now(),
        summary: conversationSummary,
      };

      const next =
        idx === -1
          ? [updatedConvo, ...prev]
          : prev.map((c, i) => (i === idx ? updatedConvo : c));

      next.sort((a, b) => b.updatedAt - a.updatedAt);

      try {
        localStorage.setItem(CONV_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // storage full or unavailable — non-fatal
      }

      return next;
    });
  }, [messages, currentConversationId, conversationSummary]);

  function startNewConversation() {
    setCurrentConversationId(makeId());
    setMessages([]);
    setConversationSummary("");
    setShowHistory(false);
  }

  function selectConversation(id: string) {
    const convo = conversations.find((c) => c.id === id);
    if (!convo) return;
    setCurrentConversationId(id);
    setMessages(convo.messages);
    setConversationSummary(convo.summary ?? "");
    setShowHistory(false);
  }

  function deleteConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      try {
        localStorage.setItem(CONV_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // non-fatal
      }
      return next;
    });
    if (id === currentConversationId) {
      startNewConversation();
    }
  }

  function forgetFact(index: number) {
    setMemoryFacts((prev) => {
      const next = prev.filter((_, i) => i !== index);
      try {
        localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // non-fatal
      }
      return next;
    });
  }

  // ---- Hands-free panel control ----
  // These are the ONLY functions that actually change panel visibility.
  // Both the header buttons (mouse/touch) and the open_panel/close_panel
  // voice tool calls route through these, so behavior stays identical
  // whether the user clicks or speaks.

  // Opens exactly one panel, hiding the others that share the same slot.
  // "history" lives in its own left-hand slot, so opening it doesn't touch
  // the right-hand panels and vice versa — mirrors the original mouse
  // button behavior. "browser" shares the right-hand slot with code/app/files.
  function openPanelByName(panel: PanelName) {
    if (panel === "history") {
      setShowHistory(true);
      return;
    }
    setShowCodeEditor(panel === "code");
    setShowAppPreview(panel === "app");
    setShowFileOutput(panel === "files");
    setShowBrowser(panel === "browser");
    setShowSettings(panel === "settings");
    if (panel === "settings") refreshAllowedApps();
  }

  // Closes one named panel, or — if no panel is named — whatever is
  // currently open. This covers "close it" / "close that panel" during a
  // live call without the user needing to say which one.
  function closePanelByName(panel?: PanelName | null) {
    if (!panel) {
      setShowHistory(false);
      setShowCodeEditor(false);
      setShowAppPreview(false);
      setShowFileOutput(false);
      setShowBrowser(false);
      setShowSettings(false);
      return;
    }
    if (panel === "history") setShowHistory(false);
    if (panel === "code") setShowCodeEditor(false);
    if (panel === "app") setShowAppPreview(false);
    if (panel === "files") setShowFileOutput(false);
    if (panel === "browser") setShowBrowser(false);
    if (panel === "settings") setShowSettings(false);
  }

  // ---- In-app "browser" tool handlers ----
  // These replace the old window.open-based open_link/close_link: instead
  // of a real new browser tab, a link opens as a tab inside the app's own
  // Browser panel. Note: some sites send headers (X-Frame-Options / CSP
  // frame-ancestors) that block being shown in ANY iframe — those will
  // load blank here, which is why every tab also gets an "Open externally"
  // fallback link in the panel itself.

  // A handful of sites publish a dedicated "embed" URL format specifically
  // meant to work inside someone else's iframe, even though their main
  // site blocks it. We rewrite recognized links into that form so they
  // actually play/load hands-free instead of coming up blank. This only
  // covers a single piece of content (one video, one clip) — it can't make
  // a site's search results, home feed, or logged-in pages embeddable,
  // since those really are blocked at the server and there's no client-side
  // workaround for that.
  function toEmbeddableUrl(rawUrl: string): string {
    try {
      const u = new URL(rawUrl);
      const host = u.hostname.replace(/^www\./, "");

      if (host === "youtube.com" || host === "m.youtube.com") {
        const id = u.searchParams.get("v");
        if (id) return `https://www.youtube.com/embed/${id}`;
        const shortsMatch = u.pathname.match(/^\/shorts\/([\w-]+)/);
        if (shortsMatch)
          return `https://www.youtube.com/embed/${shortsMatch[1]}`;
      }
      if (host === "youtu.be") {
        const id = u.pathname.replace(/^\//, "");
        if (id) return `https://www.youtube.com/embed/${id}`;
      }
      if (host === "vimeo.com") {
        const id = u.pathname.replace(/^\//, "");
        if (/^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
      }
      return rawUrl;
    } catch {
      return rawUrl;
    }
  }

  // Sites known to block embedding entirely, with no embed-URL escape
  // hatch — used purely to warn the person up front instead of letting
  // them wait on a page that will only ever load blank.
  const NO_EMBED_HOSTS = [
    "google.com",
    "instagram.com",
    "facebook.com",
    "x.com",
    "twitter.com",
    "linkedin.com",
  ];

  function openLinkInApp(args: Record<string, unknown>): string {
    const { url, title } = args;
    if (!url || !String(url).trim()) return "No URL given to open.";
    const rawUrl = String(url).trim();
    const finalUrl = toEmbeddableUrl(rawUrl);
    const tab: BrowserTab = {
      id: makeId(),
      url: finalUrl,
      originalUrl: rawUrl,
      title: title ? String(title) : rawUrl,
    };
    setBrowserTabs((prev) => [...prev, tab]);
    setActiveBrowserTabId(tab.id);
    openPanelByName("browser");

    let host = "";
    try {
      host = new URL(rawUrl).hostname.replace(/^www\./, "");
    } catch {
      /* not a full URL — skip the warning check */
    }
    if (NO_EMBED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      return `Opened ${tab.title} in the browser panel, but a heads up: this site usually blocks itself from loading inside another page, so it may come up blank — say "open it externally" if that happens.`;
    }
    return `Opened ${tab.title} right here in the browser panel.`;
  }

  function closeLinkInApp(args: Record<string, unknown>): string {
    const { target } = args;
    const tabs = browserTabs;
    if (tabs.length === 0) return "There's no tab open to close.";

    let idx = tabs.length - 1;
    if (target && String(target).trim()) {
      const needle = String(target).trim().toLowerCase();
      const found = tabs
        .map((t, i) => ({ t, i }))
        .reverse()
        .find(
          ({ t }) =>
            t.title.toLowerCase().includes(needle) ||
            t.url.toLowerCase().includes(needle),
        );
      if (!found) return `I couldn't find an open tab matching "${target}".`;
      idx = found.i;
    }

    const closed = tabs[idx];
    const next = tabs.filter((_, i) => i !== idx);
    setBrowserTabs(next);
    if (next.length === 0) {
      setActiveBrowserTabId(null);
      setShowBrowser(false);
    } else if (closed.id === activeBrowserTabId) {
      setActiveBrowserTabId(next[next.length - 1].id);
    }
    return `Closed ${closed.title}.`;
  }

  // ---- Native app control (desktop build only) ----
  // Matches whatever name the model heard against the user's saved
  // whitelist (case-insensitive substring, same matching style as
  // closeLinkInApp) rather than trusting the spoken name directly — an app
  // not already on the list simply can't be launched or killed, full stop.
  function findAllowedApp(name: string): AllowedApp | null {
    const needle = name.trim().toLowerCase();
    if (!needle) return null;
    const exact = allowedApps.find((a) => a.label.toLowerCase() === needle);
    if (exact) return exact;
    return (
      allowedApps.find((a) => a.label.toLowerCase().includes(needle)) ?? null
    );
  }

  // Matches edit_app/delete_app's target string against saved apps by
  // title (falling back to id, in case the model ever echoes one back).
  // Same "exact, then contains" strategy as findAllowedApp above.
  function findSavedApp(target: string): SavedApp | null {
    const needle = target.trim().toLowerCase();
    if (!needle) return null;
    const byId = savedApps.find((a) => a.id === target);
    if (byId) return byId;
    const exact = savedApps.find((a) => a.title.toLowerCase() === needle);
    if (exact) return exact;
    return savedApps.find((a) => a.title.toLowerCase().includes(needle)) ?? null;
  }

  function openSavedApp(app: SavedApp) {
    setAppPreview((prev) => {
      if (prev.url) URL.revokeObjectURL(prev.url);
      const blob = new Blob([app.html], { type: "text/html" });
      return { html: app.html, title: app.title, url: URL.createObjectURL(blob) };
    });
    setActiveAppId(app.id);
  }

  async function openAppInApp(args: Record<string, unknown>): Promise<string> {
    const { name } = args;
    if (!name || !String(name).trim()) return "No app name given to open.";
    if (!window.electronAPI) {
      return "Opening native apps only works in the desktop version of this app, not in a browser tab.";
    }
    const match = findAllowedApp(String(name));
    if (!match) {
      return `"${name}" isn't on the allowed-apps list, so I can't open it. Add it in Settings first if you want me to be able to.`;
    }
    try {
      const result = await window.electronAPI.openApp(match.id);
      return result.message;
    } catch (err) {
      console.error("open_app failed", err);
      return `Something went wrong trying to open ${match.label}.`;
    }
  }

  async function closeAppInApp(args: Record<string, unknown>): Promise<string> {
    const { name } = args;
    if (!name || !String(name).trim()) return "No app name given to close.";
    if (!window.electronAPI) {
      return "Closing native apps only works in the desktop version of this app, not in a browser tab.";
    }
    const match = findAllowedApp(String(name));
    if (!match) {
      return `"${name}" isn't on the allowed-apps list, so I can't close it.`;
    }
    try {
      const result = await window.electronAPI.closeApp(match.id);
      return result.message;
    } catch (err) {
      console.error("close_app failed", err);
      return `Something went wrong trying to close ${match.label}.`;
    }
  }

  // ---- read_vscode / edit_vscode: the one content-editing exception ----
  // These only ever talk to the local VS Code bridge extension (see
  // electron/vscodeBridge.cjs) — no other app in the whitelist has an
  // equivalent, and this module has no code path that reaches any other
  // app's files.
  async function readVscodeInApp(): Promise<string> {
    if (!window.electronAPI?.vscode) {
      return "Reading VS Code only works in the desktop version of this app.";
    }
    try {
      const ctx = await window.electronAPI.vscode.getContext();
      if (!ctx.activeFile) {
        return "VS Code is connected but no file is currently open there.";
      }
      const diagResult = await window.electronAPI.vscode.getDiagnostics().catch(() => null);
      const diagText = diagResult?.diagnostics?.length
        ? `Problems: ${diagResult.diagnostics
            .slice(0, 10)
            .map((d) => `${d.severity} at line ${d.line + 1}: ${d.message}`)
            .join("; ")}`
        : "No problems reported.";
      return [
        `Active file: ${ctx.activeFile} (${ctx.languageId ?? "unknown language"}).`,
        ctx.selectionText
          ? `Current selection:\n${ctx.selectionText}`
          : `Full file contents:\n${ctx.fullText ?? ""}`,
        diagText,
      ].join("\n\n");
    } catch (err) {
      return err instanceof Error ? err.message : "Couldn't read VS Code right now.";
    }
  }

  async function editVscodeInApp(args: Record<string, unknown>): Promise<string> {
    if (!window.electronAPI?.vscode) {
      return "Editing VS Code only works in the desktop version of this app.";
    }
    const content = String(args.content ?? "");
    const mode = args.mode === "insert" ? "insert" : "replace";
    const filePath = args.filePath ? String(args.filePath) : undefined;
    if (!content) return "No content given to write into VS Code.";
    try {
      if (mode === "insert") {
        const result = await window.electronAPI.vscode.insertAtCursor(content);
        return `Inserted the text at your cursor in ${result.filePath} and saved it.`;
      }
      const result = await window.electronAPI.vscode.replaceFile(filePath, content);
      return `Updated ${result.filePath} with the new code and saved it.`;
    } catch (err) {
      return err instanceof Error ? err.message : "Couldn't apply that edit in VS Code.";
    }
  }

  async function addAllowedApp() {
    if (!window.electronAPI) return;
    try {
      const added = await window.electronAPI.addAllowedApp();
      if (added) await refreshAllowedApps();
    } catch (err) {
      console.error("Couldn't add an allowed app", err);
    }
  }

  async function removeAllowedApp(id: string) {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.removeAllowedApp(id);
      await refreshAllowedApps();
    } catch (err) {
      console.error("Couldn't remove an allowed app", err);
    }
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const nextMessages: Message[] = [
      ...messages,
      { role: "user", text: trimmed },
    ];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setPhase("thinking");

    // Condense anything past the recent window into the running summary
    // before talking to the model, so long conversations don't quietly blow
    // past the context limit or lose earlier context.
    const { apiMessages, summary } = await condenseHistory(
      nextMessages,
      conversationSummary,
    );
    if (summary !== conversationSummary) setConversationSummary(summary);

    let reply = await askEngineer(
      apiMessages,
      memoryFacts,
      summary,
      teacherMode,
    );
    const toolCall = tryParseToolCall(reply);
    let effectiveMemory = memoryFacts;

    if (toolCall) {
      let toolResultText: string;

      if (toolCall.name === "open_link") {
        toolResultText = openLinkInApp(toolCall.arguments);
      } else if (toolCall.name === "close_link") {
        toolResultText = closeLinkInApp(toolCall.arguments);
      } else if (toolCall.name === "open_app") {
        toolResultText = await openAppInApp(toolCall.arguments);
      } else if (toolCall.name === "close_app") {
        toolResultText = await closeAppInApp(toolCall.arguments);
      } else if (toolCall.name === "read_vscode") {
        toolResultText = await readVscodeInApp();
      } else if (toolCall.name === "edit_vscode") {
        toolResultText = await editVscodeInApp(toolCall.arguments);
      } else if (toolCall.name === "write_code") {
        setPhase("coding");
        const { code, language, filename } = toolCall.arguments;
        revealCodeInEditor(
          String(code ?? ""),
          String(language ?? "text"),
          filename ? String(filename) : "",
        );
        toolResultText = `Put the code in the editor panel${
          filename ? ` as ${filename}` : ""
        } — let me know if you want anything changed.`;
      } else if (toolCall.name === "build_app") {
        setPhase("coding");
        const { html, title } = toolCall.arguments;
        const htmlStr = String(html ?? "");
        const titleStr = title ? String(title) : "Untitled app";
        const now = Date.now();
        const newApp: SavedApp = {
          id: makeId(),
          title: titleStr,
          html: htmlStr,
          createdAt: now,
          updatedAt: now,
        };
        setSavedApps((prev) => {
          const next = [...prev, newApp];
          saveSavedApps(next);
          return next;
        });
        // Keep the blob URL ready for the App tab, but don't switch to it —
        // the code editor is what should be visible while this is happening.
        openSavedApp(newApp);
        revealCodeInEditor(htmlStr, "html", titleStr);
        // build_app is about seeing the thing run, not reading its code —
        // switch straight to the App Preview panel. This matters most on a
        // live call, where there's no mouse click to switch tabs by hand.
        openPanelByName("app");
        toolResultText = `Built "${titleStr}" and saved it — you'll find it again next time too, and you can ask me to edit it or delete it whenever you want.`;
      } else if (toolCall.name === "edit_app") {
        const { target, html } = toolCall.arguments;
        const htmlStr = String(html ?? "");
        const match = target ? findSavedApp(String(target)) : savedApps[savedApps.length - 1];
        if (!match) {
          toolResultText = target
            ? `I couldn't find a saved app called "${target}".`
            : "There's no saved app to edit yet — ask me to build one first.";
        } else if (!htmlStr) {
          toolResultText = "No updated content given for that app.";
        } else {
          setPhase("coding");
          const updated: SavedApp = { ...match, html: htmlStr, updatedAt: Date.now() };
          setSavedApps((prev) => {
            const next = prev.map((a) => (a.id === match.id ? updated : a));
            saveSavedApps(next);
            return next;
          });
          openSavedApp(updated);
          revealCodeInEditor(htmlStr, "html", updated.title);
          openPanelByName("app");
          toolResultText = `Updated "${updated.title}" and saved the change.`;
        }
      } else if (toolCall.name === "delete_app") {
        const { target } = toolCall.arguments;
        const match = target ? findSavedApp(String(target)) : null;
        if (!match) {
          toolResultText = `I couldn't find a saved app called "${target ?? ""}" to delete.`;
        } else {
          setSavedApps((prev) => {
            const next = prev.filter((a) => a.id !== match.id);
            saveSavedApps(next);
            return next;
          });
          if (activeAppId === match.id) {
            setAppPreview((prev) => {
              if (prev.url) URL.revokeObjectURL(prev.url);
              return { html: "", title: "", url: "" };
            });
            setActiveAppId(null);
          }
          toolResultText = `Deleted "${match.title}".`;
        }
      } else if (toolCall.name === "make_file") {
        setPhase("coding");
        const { content, filename } = toolCall.arguments;
        const contentStr = String(content ?? "");
        const finalFilename = filename ? String(filename) : "file.txt";
        setFileOutput((prev) => {
          if (prev.url) URL.revokeObjectURL(prev.url);
          const blob = new Blob([contentStr], {
            type: mimeTypeForFilename(finalFilename),
          });
          return {
            content: contentStr,
            filename: finalFilename,
            url: URL.createObjectURL(blob),
          };
        });
        openPanelByName("files");
        toolResultText = `Made ${finalFilename} — it's ready to download or copy from the Files panel.`;
      } else if (toolCall.name === "open_panel") {
        const panel = normalizePanelName(toolCall.arguments?.panel);
        if (!panel) {
          toolResultText =
            "I didn't catch which panel to open — try history, code, app, files, browser, or settings.";
        } else {
          openPanelByName(panel);
          const label =
            panel === "history"
              ? "History"
              : panel === "code"
                ? "Code editor"
                : panel === "app"
                  ? "App preview"
                  : panel === "browser"
                    ? "Browser"
                    : panel === "settings"
                      ? "Settings"
                      : "Files";
          toolResultText = `Opened the ${label} panel for you.`;
        }
      } else if (toolCall.name === "close_panel") {
        const panel = normalizePanelName(toolCall.arguments?.panel);
        closePanelByName(panel);
        toolResultText = panel
          ? `Closed the ${panel} panel.`
          : "Closed the open panel.";
      } else {
        toolResultText = await runTool(toolCall);
      }

      // Whatever Jarvis just did, the floating character reflects it —
      // this isn't limited to a few tools, every tool call above lands
      // here, so the character is the one visibly "doing" everything the
      // app does, not just VS Code/app actions. A couple of tools return
      // long, verbose results (e.g. read_vscode's full file dump) that
      // would flood a tiny caption bubble, so those get a short fixed
      // caption instead of their raw result text.
      const captionText =
        toolCall.name === "read_vscode"
          ? "Looking at your code in VS Code…"
          : toolResultText;
      window.electronAPI?.announceToTeacher?.(captionText);

      // If the model just saved a fact, pick up the fresh memory list
      // immediately so the very next reply (and future turns) reflect it.
      if (toolCall.name === "remember") {
        effectiveMemory = loadMemory();
        setMemoryFacts(effectiveMemory);
      }

      // Feed the tool result back to the model as a fresh user turn so it can
      // phrase the final spoken reply conversationally, without ever showing
      // the raw tool JSON to the person. Built off the same condensed
      // history that was just sent, so token counts stay consistent.
      const withToolContext: Message[] = [
        ...apiMessages,
        {
          role: "user",
          text: `Tool result: ${toolResultText}. Reply to the user conversationally based on this, do not mention tools or JSON. Do not repeat any code in this reply.`,
        },
      ];
      reply = await askEngineer(
        withToolContext,
        effectiveMemory,
        summary,
        teacherMode,
      );
    }

    // If the model ignored the tools and just dropped a fenced code block
    // into plain text, catch it here too. Everything goes to the code
    // editor (with a progressive reveal) — a full HTML document also keeps
    // its blob URL ready for the App tab, but doesn't auto-switch to it.
    let displayText = reply;
    const codeBlock = extractCodeBlock(reply);
    if (codeBlock) {
      const looksLikeFullApp =
        /^\s*(<!doctype html|<html)/i.test(codeBlock.code) ||
        codeBlock.language.toLowerCase() === "html";
      if (looksLikeFullApp && /<html/i.test(codeBlock.code)) {
        setAppPreview((prev) => {
          if (prev.url) URL.revokeObjectURL(prev.url);
          const blob = new Blob([codeBlock.code], { type: "text/html" });
          return {
            html: codeBlock.code,
            title: "",
            url: URL.createObjectURL(blob),
          };
        });
        revealCodeInEditor(codeBlock.code, "html", "");
        displayText =
          codeBlock.cleanText ||
          "I've put the code in the editor panel — open the App tab to preview it.";
      } else {
        revealCodeInEditor(codeBlock.code, codeBlock.language, "");
        displayText =
          codeBlock.cleanText || "I've put the code in the editor panel.";
      }
    }

    // Prepare the audio BEFORE showing the reply, so the text bubble and the
    // voice appear together instead of the text sitting there silently first.
    // If TTS fails, audio is null and playAndWait below just stays silent —
    // there is no browser-voice fallback.
    const audio = await prepareSpeech(displayText);

    setMessages([...nextMessages, { role: "model", text: displayText }]);
    setLoading(false);
    setPhase("speaking");

    await playAndWait(audio);

    if (callActiveRef.current) {
      setPhase("listening");
      beginCallTurn();
    } else {
      setPhase("idle");
    }
  }

  // Listens once, resolves with the transcript (or "" if nothing usable came through).
  async function listenOnce(): Promise<string> {
    if (!micInputSupported()) return "";
    setListening(true);
    try {
      const blob = await recordUntilSilence((stop) => {
        stopListeningRef.current = stop;
      });
      if (!blob) return "";
      return await transcribeAudio(blob, recognitionLang);
    } catch (err) {
      console.error("Listening failed:", err);
      return "";
    } finally {
      stopListeningRef.current = null;
      setListening(false);
    }
  }

  // One turn of the live call: listen, then send whatever was heard.
  // sendMessage itself re-triggers the next turn once it's done speaking,
  // as long as the call is still active — that's the hands-free loop.
  async function beginCallTurn() {
    const transcript = await listenOnce();
    if (!callActiveRef.current) return;
    if (!transcript) {
      // Nothing heard — just listen again rather than dropping the call.
      beginCallTurn();
      return;
    }
    setPhase("thinking");
    const refined = await refineTranscript(transcript);
    if (!callActiveRef.current) return;
    sendMessage(refined);
  }

  function startCall() {
    setCallActive(true);
    callActiveRef.current = true;
    setPhase("listening");
    beginCallTurn();
  }

  function endCall() {
    setCallActive(false);
    callActiveRef.current = false;
    stopListeningRef.current?.();
    setPhase("idle");
  }

  function toggleListening() {
    if (listening) {
      stopListeningRef.current?.();
      return;
    }
    listenOnce().then(async (transcript) => {
      if (!transcript) return;
      setPhase("thinking");
      const refined = await refineTranscript(transcript);
      sendMessage(refined);
    });
  }

  // Reveals code into the editor progressively rather than snapping straight
  // to the final result, so there's visible "code progress" to watch. This
  // is a reveal animation of the already-received code (the chat API here
  // isn't a streaming endpoint) — not a re-generation in real time, but it
  // gives the same sense of watching it get written.
  function revealCodeInEditor(
    code: string,
    language: string,
    filename: string,
  ) {
    if (streamTimerRef.current) clearInterval(streamTimerRef.current);
    openPanelByName("code");
    setIsStreamingCode(true);
    setCodeEditor({ code: "", language, filename });

    const totalSteps = 60;
    const chunkSize = Math.max(3, Math.ceil(code.length / totalSteps));
    let i = 0;
    streamTimerRef.current = setInterval(() => {
      i += chunkSize;
      if (i >= code.length) {
        setCodeEditor({ code, language, filename });
        setIsStreamingCode(false);
        if (streamTimerRef.current) clearInterval(streamTimerRef.current);
        streamTimerRef.current = null;
      } else {
        setCodeEditor((prev) => ({ ...prev, code: code.slice(0, i) }));
      }
    }, 18);
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(codeEditor.code);
      setCopyLabel("Copied!");
    } catch {
      setCopyLabel("Copy failed");
    } finally {
      setTimeout(() => setCopyLabel("Copy"), 1500);
    }
  }

  async function copyAppLink() {
    try {
      await navigator.clipboard.writeText(appPreview.url);
      setAppLinkLabel("Copied!");
    } catch {
      setAppLinkLabel("Copy failed");
    } finally {
      setTimeout(() => setAppLinkLabel("Copy link"), 1500);
    }
  }

  // Header buttons now route through the shared open/close helpers so
  // mouse clicks and voice commands behave identically.
  function toggleHistory() {
    if (showHistory) closePanelByName("history");
    else openPanelByName("history");
  }

  function toggleCodeEditor() {
    if (showCodeEditor) closePanelByName("code");
    else openPanelByName("code");
  }

  function toggleAppPreview() {
    if (showAppPreview) closePanelByName("app");
    else openPanelByName("app");
  }

  function toggleFileOutput() {
    if (showFileOutput) closePanelByName("files");
    else openPanelByName("files");
  }

  function toggleBrowser() {
    if (showBrowser) closePanelByName("browser");
    else openPanelByName("browser");
  }

  function toggleSettings() {
    if (showSettings) closePanelByName("settings");
    else openPanelByName("settings");
  }

  async function copyFileContent() {
    try {
      await navigator.clipboard.writeText(fileOutput.content);
      setCopyFileLabel("Copied!");
    } catch {
      setCopyFileLabel("Copy failed");
    } finally {
      setTimeout(() => setCopyFileLabel("Copy"), 1500);
    }
  }

  // Sends the current editor code back to Jarvis asking for a plain-language,
  // line-by-line walkthrough. Kept as a normal chat/spoken reply (not routed
  // back into the editor) since an explanation is prose, not new code.
  function explainCode() {
    if (!codeEditor.code.trim() || loading) return;
    sendMessage(
      `Explain this code line by line, in plain language:\n${codeEditor.code}`,
    );
  }

  // Sends whatever code was pasted, plus the instruction, as one message —
  // the model will respond with write_code (or a fenced block), both of
  // which get routed straight back into the editor panel. Can be called as
  // many times as needed; there's no cap on rounds of edits.
  function submitCodeRequest() {
    const code = pastedCode.trim();
    const instruction = codeInstruction.trim();
    if (!code && !instruction) return;

    let prompt = "";
    if (code) {
      prompt += `Here is my code:\n\`\`\`\n${code}\n\`\`\`\n`;
    }
    prompt += instruction || "Please review this and suggest improvements.";

    sendMessage(prompt);
    setCodeInstruction("");
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#030507] text-[#d7f3ff] font-mono relative overflow-hidden">
      {/* ambient grid */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(#3ddcff 1px, transparent 1px), linear-gradient(90deg, #3ddcff 1px, transparent 1px)",
          backgroundSize: "42px 42px",
        }}
      />

      {/* corner brackets */}
      <div className="pointer-events-none absolute top-3 left-3 w-10 h-10 border-t-2 border-l-2 border-[#3ddcff]/60" />
      <div className="pointer-events-none absolute top-3 right-3 w-10 h-10 border-t-2 border-r-2 border-[#3ddcff]/60" />
      <div className="pointer-events-none absolute bottom-3 left-3 w-10 h-10 border-b-2 border-l-2 border-[#3ddcff]/60" />
      <div className="pointer-events-none absolute bottom-3 right-3 w-10 h-10 border-b-2 border-r-2 border-[#3ddcff]/60" />

      <header className="relative px-3 sm:px-6 py-3 sm:py-4 border-b border-[#123047] flex flex-wrap items-center justify-between gap-y-2 gap-x-3 z-10">
        <div className="flex items-center gap-2 sm:gap-3">
          <span
            className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full shrink-0"
            style={{
              background: listening ? "#ff9d4d" : "#3ddcff",
              boxShadow: `0 0 10px 2px ${listening ? "#ff9d4d" : "#3ddcff"}`,
            }}
          />
          <div>
            <h1 className="text-sm sm:text-lg tracking-[0.25em] sm:tracking-[0.35em] font-bold text-[#8fe3ff]">
              J.A.R.V.I.S
            </h1>
            <p className="hidden sm:block text-[10px] tracking-widest text-[#3d6b85] uppercase">
              Just A Rather Very Intelligent System
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-4 flex-wrap justify-end">
          <div className="hidden md:block text-right text-[10px] text-[#3d6b85] uppercase tracking-widest leading-relaxed">
            <div>
              Status:{" "}
              <span className="text-[#8fe3ff]">
                {loading ? "PROCESSING" : listening ? "LISTENING" : "STANDBY"}
              </span>
            </div>
            <div>
              Channel: <span className="text-[#8fe3ff]">{recognitionLang}</span>
            </div>
          </div>
          <button
            onClick={toggleHistory}
            aria-label={
              showHistory ? "Close history panel" : "Open history panel"
            }
            className="px-2.5 sm:px-3 py-1.5 sm:py-2 text-[9px] sm:text-[10px] font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase border border-[#1c5578] text-[#8fe3ff] hover:border-[#3ddcff] transition-colors whitespace-nowrap"
          >
            ☰ <span className="hidden sm:inline">History</span>
          </button>
          <button
            onClick={toggleCodeEditor}
            aria-label={
              showCodeEditor
                ? "Close code editor panel"
                : "Open code editor panel"
            }
            className="px-2.5 sm:px-3 py-1.5 sm:py-2 text-[9px] sm:text-[10px] font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase border border-[#1c5578] text-[#8fe3ff] hover:border-[#3ddcff] transition-colors whitespace-nowrap"
          >
            {"</>"} <span className="hidden sm:inline">Code</span>
          </button>
          <button
            onClick={toggleAppPreview}
            aria-label={
              showAppPreview
                ? "Close app preview panel"
                : "Open app preview panel"
            }
            className="px-2.5 sm:px-3 py-1.5 sm:py-2 text-[9px] sm:text-[10px] font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase border border-[#1c5578] text-[#8fe3ff] hover:border-[#3ddcff] transition-colors whitespace-nowrap"
          >
            ▶ <span className="hidden sm:inline">App</span>
          </button>
          <button
            onClick={toggleBrowser}
            aria-label={
              showBrowser
                ? "Close browser panel"
                : `Open browser panel${browserTabs.length > 0 ? `, ${browserTabs.length} tabs open` : ""}`
            }
            className="px-2.5 sm:px-3 py-1.5 sm:py-2 text-[9px] sm:text-[10px] font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase border border-[#1c5578] text-[#8fe3ff] hover:border-[#3ddcff] transition-colors whitespace-nowrap"
          >
            🌐 <span className="hidden sm:inline">Browser</span>
            {browserTabs.length > 0 && (
              <span className="ml-1 text-[#3ddcff]">
                ({browserTabs.length})
              </span>
            )}
          </button>
          <button
            onClick={toggleFileOutput}
            aria-label={
              showFileOutput ? "Close files panel" : "Open files panel"
            }
            className="px-2.5 sm:px-3 py-1.5 sm:py-2 text-[9px] sm:text-[10px] font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase border border-[#1c5578] text-[#8fe3ff] hover:border-[#3ddcff] transition-colors whitespace-nowrap"
          >
            ⬇ <span className="hidden sm:inline">Files</span>
          </button>
          {isDesktopApp && (
            <button
              onClick={toggleSettings}
              aria-label={
                showSettings ? "Close settings panel" : "Open settings panel"
              }
              className="px-2.5 sm:px-3 py-1.5 sm:py-2 text-[9px] sm:text-[10px] font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase border border-[#1c5578] text-[#8fe3ff] hover:border-[#3ddcff] transition-colors whitespace-nowrap"
            >
              ⚙ <span className="hidden sm:inline">Settings</span>
            </button>
          )}
          <button
            onClick={callActive ? endCall : startCall}
            aria-label={callActive ? "End live call" : "Start live call"}
            className={`px-3 sm:px-4 py-1.5 sm:py-2 text-[9px] sm:text-[10px] font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase border transition-colors whitespace-nowrap ${
              callActive
                ? "border-[#ff5d5d] text-[#ff5d5d] hover:bg-[#ff5d5d]/10"
                : "border-[#3ddcff] text-[#3ddcff] hover:bg-[#3ddcff]/10"
            }`}
          >
            {callActive ? "● End Call" : "Start Live Call"}
          </button>
        </div>
      </header>

      <div className="relative flex-1 flex overflow-hidden z-10">
        {/* history + memory panel */}
        {showHistory && (
          <div className="absolute inset-y-0 left-0 w-full sm:w-72 z-30 bg-[#03060a]/95 border-r border-[#123047] backdrop-blur-sm flex flex-col p-4 gap-2 overflow-y-auto">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] tracking-[0.3em] text-[#3d6b85] uppercase">
                Chat History
              </span>
              <button
                onClick={() => closePanelByName("history")}
                className="text-[#3d6b85] hover:text-[#3ddcff] text-xs"
              >
                ✕
              </button>
            </div>

            <button
              onClick={startNewConversation}
              className="text-left px-3 py-2 border border-[#3ddcff] text-[#3ddcff] text-[10px] font-bold tracking-widest uppercase hover:bg-[#3ddcff]/10 transition-colors"
            >
              + New Chat
            </button>

            <div className="mt-2 flex flex-col gap-1">
              {conversations.length === 0 && (
                <p className="text-[#3d6b85] text-xs">No saved chats yet.</p>
              )}
              {conversations.map((c) => (
                <div
                  key={c.id}
                  onClick={() => selectConversation(c.id)}
                  className={`group flex items-center justify-between px-3 py-2 border cursor-pointer text-xs transition-colors ${
                    c.id === currentConversationId
                      ? "border-[#3ddcff] bg-[#3ddcff]/10 text-[#8fe3ff]"
                      : "border-[#123047] text-[#c9e8f7] hover:border-[#1c5578]"
                  }`}
                >
                  <span className="truncate">{c.title}</span>
                  <button
                    onClick={(e) => deleteConversation(c.id, e)}
                    className="opacity-0 group-hover:opacity-100 text-[#ff5d5d] ml-2 shrink-0"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-4 pt-3 border-t border-[#123047]">
              <button
                onClick={() => setTeacherMode((prev) => !prev)}
                className="w-full flex items-center justify-between px-1"
              >
                <span className="text-[10px] tracking-[0.3em] text-[#3d6b85] uppercase">
                  Teacher Mode
                </span>
                <span
                  className={`relative inline-flex h-4 w-8 items-center border transition-colors ${
                    teacherMode
                      ? "border-[#3ddcff] bg-[#3ddcff]/20"
                      : "border-[#123047] bg-transparent"
                  }`}
                >
                  <span
                    className={`inline-block h-2.5 w-2.5 transform transition-transform ${
                      teacherMode
                        ? "translate-x-4 bg-[#3ddcff]"
                        : "translate-x-1 bg-[#3d6b85]"
                    }`}
                  />
                </span>
              </button>
              <p className="mt-1 text-[10px] text-[#3d6b85] leading-tight">
                {teacherMode
                  ? "Engineer will quiz you instead of answering directly."
                  : "Off — Engineer answers directly."}
              </p>
            </div>

            <div className="mt-4 pt-3 border-t border-[#123047]">
              <span className="text-[10px] tracking-[0.3em] text-[#3d6b85] uppercase">
                Memory
              </span>
              <div className="mt-2 flex flex-col gap-1">
                {memoryFacts.length === 0 && (
                  <p className="text-[#3d6b85] text-xs">
                    Nothing remembered yet.
                  </p>
                )}
                {memoryFacts.map((fact, i) => (
                  <div
                    key={i}
                    className="group flex items-center justify-between px-2 py-1 text-[11px] text-[#c9e8f7]"
                  >
                    <span className="truncate">{fact}</span>
                    <button
                      onClick={() => forgetFact(i)}
                      className="opacity-0 group-hover:opacity-100 text-[#ff5d5d] ml-2 shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* code editor panel */}
        {showCodeEditor && (
          <div className="absolute inset-y-0 right-0 w-full sm:w-[26rem] z-30 bg-[#03060a]/95 border-l border-[#123047] backdrop-blur-sm flex flex-col p-4 gap-3 overflow-y-auto">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] tracking-[0.3em] text-[#3d6b85] uppercase">
                Code Editor
              </span>
              <button
                onClick={() => closePanelByName("code")}
                className="text-[#3d6b85] hover:text-[#3ddcff] text-xs"
              >
                ✕
              </button>
            </div>

            <div className="border border-[#123047] bg-[#0a0f14] flex flex-col min-h-[12rem]">
              <div className="flex items-center justify-between px-3 py-2 border-b border-[#123047] text-[9px] uppercase tracking-widest text-[#3d6b85]">
                <span className="truncate flex items-center gap-2">
                  {isStreamingCode && (
                    <span className="text-[#6dffb0]">● writing</span>
                  )}
                  <span>
                    {codeEditor.filename ||
                      codeEditor.language ||
                      (isStreamingCode ? "" : "no code yet")}
                  </span>
                </span>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={explainCode}
                    disabled={!codeEditor.code || loading || isStreamingCode}
                    className="text-[#3ddcff] hover:text-[#8fe3ff] disabled:opacity-30 disabled:hover:text-[#3ddcff] tracking-widest"
                  >
                    Explain
                  </button>
                  <button
                    onClick={copyCode}
                    disabled={!codeEditor.code || isStreamingCode}
                    className="text-[#3ddcff] hover:text-[#8fe3ff] disabled:opacity-30 disabled:hover:text-[#3ddcff] tracking-widest"
                  >
                    {copyLabel}
                  </button>
                </div>
              </div>
              <pre className="flex-1 overflow-auto p-3 text-[11px] leading-relaxed text-[#c9e8f7] whitespace-pre-wrap break-words">
                {codeEditor.code ||
                  (isStreamingCode
                    ? ""
                    : "Ask Jarvis to write or debug something, or paste your own code below.")}
                {isStreamingCode && (
                  <span className="code-cursor-blink inline-block">▋</span>
                )}
              </pre>
            </div>

            <div className="mt-2 pt-3 border-t border-[#123047] flex flex-col gap-2">
              <span className="text-[10px] tracking-[0.3em] text-[#3d6b85] uppercase">
                Paste code to debug or extend
              </span>
              <textarea
                value={pastedCode}
                onChange={(e) => setPastedCode(e.target.value)}
                placeholder="Paste your code here..."
                rows={8}
                className="bg-[#0a0f14] border border-[#123047] px-3 py-2 text-[11px] text-[#e8f6ff] placeholder-[#2d4f63] outline-none focus:border-[#3ddcff] transition-colors font-mono resize-y"
              />
              <input
                value={codeInstruction}
                onChange={(e) => setCodeInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCodeRequest();
                }}
                placeholder="e.g. fix this bug / add a dark mode toggle"
                className="bg-[#0a0f14] border border-[#123047] px-3 py-2 text-xs text-[#e8f6ff] placeholder-[#2d4f63] outline-none focus:border-[#3ddcff] transition-colors"
              />
              <button
                onClick={submitCodeRequest}
                disabled={
                  loading || (!pastedCode.trim() && !codeInstruction.trim())
                }
                className="px-4 py-2 border border-[#3ddcff] text-[#3ddcff] text-[10px] font-bold tracking-[0.2em] uppercase hover:bg-[#3ddcff]/10 transition-colors disabled:opacity-30"
              >
                Send to Jarvis
              </button>
            </div>
          </div>
        )}

        {/* app preview panel */}
        {showAppPreview && (
          <div className="absolute inset-y-0 right-0 w-full sm:w-[28rem] z-30 bg-[#03060a]/95 border-l border-[#123047] backdrop-blur-sm flex flex-col p-4 gap-3 overflow-y-auto">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] tracking-[0.3em] text-[#3d6b85] uppercase">
                App Preview
              </span>
              <button
                onClick={() => closePanelByName("app")}
                className="text-[#3d6b85] hover:text-[#3ddcff] text-xs"
              >
                ✕
              </button>
            </div>

            {savedApps.length > 0 && (
              <div className="border border-[#123047] bg-[#0a0f14] flex flex-col max-h-32 overflow-y-auto">
                {savedApps
                  .slice()
                  .sort((a, b) => b.updatedAt - a.updatedAt)
                  .map((app) => (
                    <div
                      key={app.id}
                      className={`flex items-center justify-between px-3 py-1.5 text-[10px] border-b border-[#123047] last:border-b-0 ${
                        activeAppId === app.id ? "text-[#3ddcff]" : "text-[#7fa6bb]"
                      }`}
                    >
                      <button
                        onClick={() => openSavedApp(app)}
                        className="truncate text-left flex-1 hover:text-[#3ddcff]"
                      >
                        {app.title}
                      </button>
                      <button
                        onClick={() => {
                          setSavedApps((prev) => {
                            const next = prev.filter((a) => a.id !== app.id);
                            saveSavedApps(next);
                            return next;
                          });
                          if (activeAppId === app.id) {
                            setAppPreview((prev) => {
                              if (prev.url) URL.revokeObjectURL(prev.url);
                              return { html: "", title: "", url: "" };
                            });
                            setActiveAppId(null);
                          }
                        }}
                        className="text-[#3d6b85] hover:text-red-400 ml-2 shrink-0"
                      >
                        delete
                      </button>
                    </div>
                  ))}
              </div>
            )}

            <div className="border border-[#123047] bg-[#0a0f14] flex flex-col">
              <div className="flex items-center justify-between px-3 py-2 border-b border-[#123047] text-[9px] uppercase tracking-widest text-[#3d6b85]">
                <span className="truncate">
                  {appPreview.title || "no app yet"}
                </span>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() =>
                      appPreview.url &&
                      window.open(
                        appPreview.url,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                    disabled={!appPreview.url}
                    className="text-[#3ddcff] hover:text-[#8fe3ff] disabled:opacity-30 disabled:hover:text-[#3ddcff] tracking-widest"
                  >
                    Open in new tab
                  </button>
                  <button
                    onClick={copyAppLink}
                    disabled={!appPreview.url}
                    className="text-[#3ddcff] hover:text-[#8fe3ff] disabled:opacity-30 disabled:hover:text-[#3ddcff] tracking-widest"
                  >
                    {appLinkLabel}
                  </button>
                </div>
              </div>
              {appPreview.html ? (
                <iframe
                  title={appPreview.title || "App preview"}
                  srcDoc={appPreview.html}
                  sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
                  className="w-full h-[45vh] sm:h-[55vh] bg-white"
                />
              ) : (
                <p className="p-3 text-[11px] text-[#c9e8f7] leading-relaxed">
                  Ask Jarvis to build you an app, and the live preview will show
                  up here.
                </p>
              )}
            </div>

            <p className="text-[9px] text-[#3d6b85] leading-relaxed">
              This link only works on this device for this browser session —
              it's a local preview, not a hosted public URL. Reloading the page
              or closing the tab will invalidate it; use "Open in new tab" or
              copy the code to deploy it somewhere permanent.
            </p>
          </div>
        )}

        {/* in-app browser panel */}
        {showBrowser && (
          <div className="absolute inset-y-0 right-0 w-full sm:w-[30rem] z-30 bg-[#03060a]/95 border-l border-[#123047] backdrop-blur-sm flex flex-col p-4 gap-3 overflow-y-auto">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] tracking-[0.3em] text-[#3d6b85] uppercase">
                Browser
              </span>
              <button
                onClick={() => closePanelByName("browser")}
                className="text-[#3d6b85] hover:text-[#3ddcff] text-xs"
              >
                ✕
              </button>
            </div>

            {browserTabs.length > 0 && (
              <div className="flex items-center gap-1 overflow-x-auto pb-1 -mx-1 px-1">
                {browserTabs.map((tab) => (
                  <div
                    key={tab.id}
                    onClick={() => setActiveBrowserTabId(tab.id)}
                    className={`group flex items-center gap-1.5 shrink-0 max-w-[9rem] px-2.5 py-1.5 border cursor-pointer text-[10px] transition-colors ${
                      tab.id === activeBrowserTabId
                        ? "border-[#3ddcff] bg-[#3ddcff]/10 text-[#8fe3ff]"
                        : "border-[#123047] text-[#c9e8f7] hover:border-[#1c5578]"
                    }`}
                  >
                    <span className="truncate">{tab.title}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeLinkInApp({ target: tab.title });
                      }}
                      className="opacity-0 group-hover:opacity-100 text-[#ff5d5d] shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="border border-[#123047] bg-[#0a0f14] flex flex-col">
              <div className="flex items-center justify-between px-3 py-2 border-b border-[#123047] text-[9px] uppercase tracking-widest text-[#3d6b85]">
                <span className="truncate">
                  {activeBrowserTab?.originalUrl || "no page open"}
                </span>
                <button
                  onClick={() =>
                    activeBrowserTab &&
                    window.open(
                      activeBrowserTab.originalUrl,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                  disabled={!activeBrowserTab}
                  className="text-[#3ddcff] hover:text-[#8fe3ff] disabled:opacity-30 disabled:hover:text-[#3ddcff] tracking-widest shrink-0"
                >
                  Open externally
                </button>
              </div>
              {activeBrowserTab ? (
                <iframe
                  key={activeBrowserTab.id}
                  title={activeBrowserTab.title}
                  src={activeBrowserTab.url}
                  className="w-full h-[45vh] sm:h-[55vh] bg-white"
                />
              ) : (
                <p className="p-3 text-[11px] text-[#c9e8f7] leading-relaxed">
                  Ask Jarvis to open a link, and it'll load right here.
                </p>
              )}
            </div>

            <p className="text-[9px] text-[#3d6b85] leading-relaxed">
              Some sites block being shown inside another page and will appear
              blank here — use "Open externally" for those. Say "close it" or
              "close the [site name] one" to close a tab hands free.
            </p>
          </div>
        )}

        {/* settings panel — allowed native apps */}
        {showSettings && (
          <div className="absolute inset-y-0 right-0 w-full sm:w-96 z-30 bg-[#03060a]/95 border-l border-[#123047] backdrop-blur-sm flex flex-col p-4 gap-3 overflow-y-auto">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] tracking-[0.3em] text-[#3d6b85] uppercase">
                Settings
              </span>
              <button
                onClick={() => closePanelByName("settings")}
                aria-label="Close settings panel"
                className="text-[#3d6b85] hover:text-[#3ddcff] text-xs"
              >
                ✕
              </button>
            </div>

            <div>
              <span className="text-[10px] tracking-[0.3em] text-[#3d6b85] uppercase">
                Apps Jarvis can open or close
              </span>
              <p className="mt-1 text-[10px] text-[#3d6b85] leading-relaxed">
                Only apps on this list can be opened or closed by voice or chat
                — nothing else. Closing an app force-quits it, same as ending
                its task; save your work first.
              </p>
            </div>

            <button
              onClick={addAllowedApp}
              className="text-left px-3 py-2 border border-[#3ddcff] text-[#3ddcff] text-[10px] font-bold tracking-widest uppercase hover:bg-[#3ddcff]/10 transition-colors"
            >
              + Add an app…
            </button>

            <div className="flex flex-col gap-1">
              {allowedApps.length === 0 && (
                <p className="text-[#3d6b85] text-xs">
                  No apps allowed yet — add one above.
                </p>
              )}
              {allowedApps.map((app) => (
                <div
                  key={app.id}
                  className="group flex items-center justify-between px-3 py-2 border border-[#123047] text-xs text-[#c9e8f7]"
                >
                  <span className="truncate">{app.label}</span>
                  <button
                    onClick={() => removeAllowedApp(app.id)}
                    aria-label={`Remove ${app.label} from allowed apps`}
                    className="opacity-0 group-hover:opacity-100 text-[#ff5d5d] ml-2 shrink-0"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* file output panel */}
        {showFileOutput && (
          <div className="absolute inset-y-0 right-0 w-full sm:w-[26rem] z-30 bg-[#03060a]/95 border-l border-[#123047] backdrop-blur-sm flex flex-col p-4 gap-3 overflow-y-auto">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] tracking-[0.3em] text-[#3d6b85] uppercase">
                Files
              </span>
              <button
                onClick={() => closePanelByName("files")}
                className="text-[#3d6b85] hover:text-[#3ddcff] text-xs"
              >
                ✕
              </button>
            </div>

            <div className="border border-[#123047] bg-[#0a0f14] flex flex-col min-h-[12rem]">
              <div className="flex items-center justify-between px-3 py-2 border-b border-[#123047] text-[9px] uppercase tracking-widest text-[#3d6b85]">
                <span className="truncate">
                  {fileOutput.filename || "no file yet"}
                </span>
                <div className="flex items-center gap-3 shrink-0">
                  <a
                    href={fileOutput.url || undefined}
                    download={fileOutput.filename || undefined}
                    className={`text-[#3ddcff] hover:text-[#8fe3ff] tracking-widest ${
                      !fileOutput.url ? "opacity-30 pointer-events-none" : ""
                    }`}
                  >
                    Download
                  </a>
                  <button
                    onClick={copyFileContent}
                    disabled={!fileOutput.content}
                    className="text-[#3ddcff] hover:text-[#8fe3ff] disabled:opacity-30 disabled:hover:text-[#3ddcff] tracking-widest"
                  >
                    {copyFileLabel}
                  </button>
                </div>
              </div>
              <pre className="flex-1 overflow-auto p-3 text-[11px] leading-relaxed text-[#c9e8f7] whitespace-pre-wrap break-words">
                {fileOutput.content ||
                  "Ask Jarvis to write you a file — a document, notes, a CSV, anything downloadable — and it'll show up here."}
              </pre>
            </div>

            <p className="text-[9px] text-[#3d6b85] leading-relaxed">
              Download saves it straight to your device. Copy puts the raw
              content on your clipboard to paste anywhere. Like the other
              panels, this link only lives for this browser session.
            </p>
          </div>
        )}

        {/* telemetry sidebar */}
        <aside className="hidden md:flex w-56 shrink-0 border-r border-[#123047] flex-col p-4 gap-3 bg-[#03060a]/60">
          <div className="text-[9px] tracking-[0.3em] text-[#3d6b85] uppercase mb-1">
            System Telemetry
          </div>
          {telemetry.map((line, i) => (
            <div
              key={i}
              className="text-[10px] text-[#4fb8dd] tracking-wide whitespace-pre"
            >
              {line}
            </div>
          ))}
          <div className="mt-auto pt-3 border-t border-[#123047] text-[9px] text-[#3d6b85] tracking-widest uppercase">
            Session log: {messages.length} entries
          </div>
        </aside>

        <div className="flex-1 flex flex-col">
          <main className="relative flex-1 overflow-y-auto px-3 sm:px-6 py-4 sm:py-5 space-y-3">
            {callActive && (
              <div className="absolute inset-0 z-20 bg-[#030507]/95 backdrop-blur-sm flex flex-col items-center justify-center gap-6">
                <div className="relative w-56 h-56 flex items-center justify-center">
                  <svg
                    viewBox="0 0 200 200"
                    className="absolute inset-0 hud-dial-spin"
                  >
                    <circle
                      cx="100"
                      cy="100"
                      r="95"
                      fill="none"
                      stroke="#123047"
                      strokeWidth="1"
                    />
                    {Array.from({ length: 36 }).map((_, i) => {
                      const angle = (i * 10 * Math.PI) / 180;
                      const long = i % 3 === 0;
                      const r1 = 95;
                      const r2 = long ? 84 : 90;
                      const x1 = 100 + r1 * Math.cos(angle);
                      const y1 = 100 + r1 * Math.sin(angle);
                      const x2 = 100 + r2 * Math.cos(angle);
                      const y2 = 100 + r2 * Math.sin(angle);
                      return (
                        <line
                          key={i}
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          stroke={phaseColor(phase)}
                          strokeWidth={long ? 2 : 1}
                          opacity={long ? 0.8 : 0.35}
                        />
                      );
                    })}
                  </svg>
                  <svg
                    viewBox="0 0 200 200"
                    className={`absolute inset-0 ${
                      phase === "thinking" || phase === "coding"
                        ? "hud-sweep-fast"
                        : "hud-sweep"
                    }`}
                  >
                    <defs>
                      <linearGradient
                        id="sweepGradCall"
                        x1="0"
                        y1="0"
                        x2="1"
                        y2="0"
                      >
                        <stop
                          offset="0%"
                          stopColor={phaseColor(phase)}
                          stopOpacity="0"
                        />
                        <stop
                          offset="100%"
                          stopColor={phaseColor(phase)}
                          stopOpacity="0.55"
                        />
                      </linearGradient>
                    </defs>
                    <path
                      d="M100,100 L100,10 A90,90 0 0,1 168,132 Z"
                      fill="url(#sweepGradCall)"
                    />
                  </svg>
                  <div
                    className={`absolute inset-10 rounded-full border ${
                      phase === "speaking" ? "hud-ring-pulse" : "hud-ring-fast"
                    }`}
                    style={{
                      borderColor: `${phaseColor(phase)}66`,
                    }}
                  />
                  <div
                    className={`w-20 h-20 rounded-full border flex items-center justify-center text-[10px] tracking-widest ${
                      phase === "thinking" || phase === "coding"
                        ? "hud-core-fast"
                        : "hud-core"
                    }`}
                    style={{
                      background: `${phaseColor(phase)}1a`,
                      borderColor: phaseColor(phase),
                      color: phase === "idle" ? "#8fe3ff" : phaseColor(phase),
                    }}
                  >
                    {phase.toUpperCase()}
                  </div>
                </div>
                <p className="text-[#3d6b85] text-xs tracking-widest uppercase max-w-sm text-center px-6">
                  {phase === "listening" &&
                    "Listening — speak naturally, pause when done"}
                  {phase === "thinking" && "Processing your request"}
                  {phase === "coding" && "Writing your code"}
                  {phase === "speaking" && "Jarvis is responding"}
                  {phase === "idle" && "Live call active"}
                </p>
                {messages.length > 0 && (
                  <div className="max-w-md text-center text-[#c9e8f7] text-sm px-6 leading-relaxed">
                    {messages[messages.length - 1].text}
                  </div>
                )}
              </div>
            )}

            {messages.length === 0 && !callActive && (
              <div className="h-full flex flex-col items-center justify-center gap-5 text-center">
                {/* radar / targeting dial — signature element */}
                <div className="relative w-44 h-44 flex items-center justify-center">
                  <svg
                    viewBox="0 0 200 200"
                    className="absolute inset-0 hud-dial-spin"
                  >
                    <circle
                      cx="100"
                      cy="100"
                      r="95"
                      fill="none"
                      stroke="#123047"
                      strokeWidth="1"
                    />
                    {Array.from({ length: 36 }).map((_, i) => {
                      const angle = (i * 10 * Math.PI) / 180;
                      const long = i % 3 === 0;
                      const r1 = 95;
                      const r2 = long ? 84 : 90;
                      const x1 = 100 + r1 * Math.cos(angle);
                      const y1 = 100 + r1 * Math.sin(angle);
                      const x2 = 100 + r2 * Math.cos(angle);
                      const y2 = 100 + r2 * Math.sin(angle);
                      return (
                        <line
                          key={i}
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          stroke="#3ddcff"
                          strokeWidth={long ? 2 : 1}
                          opacity={long ? 0.8 : 0.35}
                        />
                      );
                    })}
                  </svg>
                  <svg
                    viewBox="0 0 200 200"
                    className="absolute inset-0 hud-sweep"
                  >
                    <defs>
                      <linearGradient
                        id="sweepGrad"
                        x1="0"
                        y1="0"
                        x2="1"
                        y2="0"
                      >
                        <stop offset="0%" stopColor="#3ddcff" stopOpacity="0" />
                        <stop
                          offset="100%"
                          stopColor="#3ddcff"
                          stopOpacity="0.55"
                        />
                      </linearGradient>
                    </defs>
                    <path
                      d="M100,100 L100,10 A90,90 0 0,1 168,132 Z"
                      fill="url(#sweepGrad)"
                    />
                  </svg>
                  <div className="absolute inset-8 rounded-full border border-[#3ddcff]/40 hud-ring-fast" />
                  <div className="w-14 h-14 rounded-full bg-[#3ddcff]/10 border border-[#3ddcff] hud-core flex items-center justify-center text-[9px] tracking-widest text-[#8fe3ff]">
                    IDLE
                  </div>
                </div>
                <p className="text-[#3d6b85] text-xs tracking-widest uppercase max-w-xs">
                  Awaiting input — speak, type, or start a live call
                </p>
              </div>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[88%] sm:max-w-lg px-3 sm:px-4 py-2.5 sm:py-3 text-sm leading-relaxed border backdrop-blur-sm ${
                    m.role === "user"
                      ? "bg-[#0b2338]/70 border-[#1c5578] text-[#eaf7ff] clip-panel-user"
                      : "bg-[#0a0f14]/80 border-[#123047] text-[#c9e8f7] clip-panel-model"
                  }`}
                >
                  <div className="text-[9px] uppercase tracking-[0.3em] mb-1 text-[#3d6b85] flex items-center gap-2">
                    <span>{m.role === "user" ? "You" : "Jarvis"}</span>
                    <span className="flex-1 h-px bg-[#123047]" />
                  </div>
                  {m.text}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="px-4 py-3 border border-[#123047] bg-[#0a0f14]/80 text-[#3ddcff] text-xs tracking-widest flex items-center gap-2">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    className="hud-mini-spin"
                  >
                    <circle
                      cx="8"
                      cy="8"
                      r="6"
                      fill="none"
                      stroke="#3ddcff"
                      strokeWidth="2"
                      strokeDasharray="28"
                      strokeDashoffset="10"
                      strokeLinecap="round"
                    />
                  </svg>
                  ANALYZING
                </div>
              </div>
            )}
            <div ref={endRef} />
          </main>

          <footer className="relative px-3 sm:px-6 py-3 sm:py-4 border-t border-[#123047] flex items-center gap-2 sm:gap-3">
            <button
              onClick={() =>
                setRecognitionLang((prev) =>
                  prev === "en-US" ? "sw-KE" : "en-US",
                )
              }
              disabled={listening}
              title="Toggle voice recognition language"
              className="shrink-0 w-9 h-9 sm:w-11 sm:h-11 border border-[#1c5578] flex items-center justify-center text-[9px] sm:text-[10px] font-bold text-[#8fe3ff] bg-[#0a0f14] disabled:opacity-30 hover:border-[#3ddcff] transition-colors"
            >
              {recognitionLang === "en-US" ? "EN" : "SW"}
            </button>

            <button
              onClick={toggleListening}
              disabled={!voiceSupported}
              title={
                voiceSupported
                  ? "Talk"
                  : "Voice input not supported in this browser"
              }
              className="relative shrink-0 w-11 h-11 sm:w-14 sm:h-14 rounded-full flex items-center justify-center disabled:opacity-30"
            >
              <span
                className={`absolute inset-0 rounded-full border ${
                  listening
                    ? "border-[#ff9d4d] hud-ring-fast"
                    : "border-[#3ddcff]/40"
                }`}
              />
              <span
                className={`w-7 h-7 sm:w-9 sm:h-9 rounded-full flex items-center justify-center text-base sm:text-lg ${
                  listening
                    ? "bg-[#ff9d4d]/20 text-[#ff9d4d]"
                    : "bg-[#3ddcff]/10 text-[#3ddcff]"
                }`}
                style={{
                  boxShadow: listening
                    ? "0 0 16px 3px rgba(255,157,77,0.5)"
                    : "0 0 12px 2px rgba(61,220,255,0.35)",
                }}
              >
                🎤
              </span>
            </button>

            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendMessage(input);
              }}
              placeholder="TRANSMIT MESSAGE..."
              className="flex-1 min-w-0 bg-[#0a0f14] border border-[#123047] px-3 sm:px-4 py-2 sm:py-2.5 text-sm text-[#e8f6ff] placeholder-[#2d4f63] outline-none focus:border-[#3ddcff] transition-colors tracking-wide"
            />

            <button
              onClick={() => sendMessage(input)}
              disabled={loading || !input.trim()}
              className="shrink-0 px-3.5 sm:px-5 py-2 sm:py-2.5 border border-[#3ddcff] text-[#3ddcff] text-[10px] sm:text-xs font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase hover:bg-[#3ddcff]/10 transition-colors disabled:opacity-30"
            >
              Send
            </button>
          </footer>
        </div>
      </div>

      <style>{`
        @keyframes hud-dial-spin-kf { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes hud-sweep-kf { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes hud-sweep-fast-kf { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes hud-ring-fast-spin { from { transform: rotate(360deg); } to { transform: rotate(0deg); } }
        @keyframes hud-ring-pulse-kf { 0%, 100% { transform: scale(1); opacity: 0.5; } 50% { transform: scale(1.06); opacity: 1; } }
        @keyframes hud-core-pulse { 0%, 100% { opacity: 0.6; transform: scale(1); } 50% { opacity: 1; transform: scale(1.08); } }
        @keyframes hud-core-fast-pulse { 0%, 100% { opacity: 0.5; transform: scale(0.96); } 50% { opacity: 1; transform: scale(1.12); } }
        @keyframes hud-dot-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
        @keyframes hud-mini-spin-kf { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .hud-dial-spin { animation: hud-dial-spin-kf 40s linear infinite; transform-origin: 100px 100px; }
        .hud-sweep { animation: hud-sweep-kf 4s linear infinite; transform-origin: 100px 100px; }
        .hud-sweep-fast { animation: hud-sweep-fast-kf 1.1s linear infinite; transform-origin: 100px 100px; }
        .hud-ring-fast { animation: hud-ring-fast-spin 3s linear infinite; }
        .hud-ring-pulse { animation: hud-ring-pulse-kf 1.2s ease-in-out infinite; }
        .hud-core { animation: hud-core-pulse 2s ease-in-out infinite; }
        .hud-core-fast { animation: hud-core-fast-pulse 0.6s ease-in-out infinite; }
        .hud-pulse-dot { width: 6px; height: 6px; border-radius: 9999px; background: #3ddcff; animation: hud-dot-pulse 1s ease-in-out infinite; display: inline-block; }
        .hud-mini-spin { animation: hud-mini-spin-kf 0.8s linear infinite; }
        .code-cursor-blink { animation: hud-dot-pulse 0.9s ease-in-out infinite; color: #6dffb0; }
        .clip-panel-user { clip-path: polygon(0 0, 100% 0, 100% 100%, 12px 100%, 0 calc(100% - 12px)); }
        .clip-panel-model { clip-path: polygon(12px 0, 100% 0, 100% 100%, 0 100%, 0 12px); }
      `}</style>
    </div>
  );
}

export default Assistant;
