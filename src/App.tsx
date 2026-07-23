import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const GEMMA_API_KEY = import.meta.env.VITE_GEMMA_API_KEY;
const CHAT_MODEL = "gemma-4-26b-a4b-it";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";
// Used only for research_idea, since it needs Google Search grounding —
// the open-weight Gemma chat model doesn't support built-in tools.
const RESEARCH_MODEL = "gemini-2.5-flash";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CONV_STORAGE_KEY = "jarvis_conversations";
const MEMORY_STORAGE_KEY = "jarvis_memory";

// Keep this many of the most recent messages verbatim in every API call;
// anything older than that gets folded into a running summary instead of
// being dropped, so the assistant doesn't lose context in long sessions.
const RECENT_MESSAGE_LIMIT = 300;
// Only re-summarize once the raw history grows this far past the recent
// window, so we're not re-summarizing on every single turn.
const SUMMARIZE_TRIGGER = RECENT_MESSAGE_LIMIT + 50;

type Role = "user" | "model";
interface Message {
  role: Role;
  text: string;
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
): string {
  const lines = [
    "You are Engineer, a helpful personal voice assistant.",
    "Keep replies short and conversational, like a real spoken response — usually 1-3 sentences unless the user clearly wants more detail.",
    "Never use markdown, bullet points, or numbered lists in your replies, since they will be read aloud.",
    "Match the language the user is using. If they write in English, reply in English. If they write in Kiswahili, reply in Kiswahili. If they mix English and Kiswahili (Sheng or everyday code-switching), reply naturally in that same mixed, conversational style — do not force pure formal Kiswahili unless the user is doing that themselves.",
    "When walking someone through a multi-step task (like programming or debugging), give ONE step at a time, keep it short, then explicitly ask something like 'let me know once you've done that' before moving to the next step. Never dump several steps at once during a live call.",
    "",
    "You have six tools you can call:",
    '1. manage_tasks(action: "add"|"list"|"complete"|"delete", title?: string, task_id?: string) — reads/writes the user\'s task list.',
    "2. research_idea(idea: string) — runs a real web search on a business idea, opens the top source in a new browser tab, and returns a short brief with citations.",
    "3. remember(fact: string) — saves a short, durable fact about the user (their name, preferences, ongoing projects, recurring context) so you can recall it in future conversations, even new ones. Call this whenever the user shares something worth remembering long-term. Do not call it for one-off details that only matter for this exchange.",
    "4. open_link(url: string, title?: string) — opens a specific URL in a new browser tab. Use this whenever the user asks you to open a link, a website, or a page they name or that came up earlier in the conversation.",
    "5. write_code(code: string, language?: string, filename?: string) — puts code into the on-screen code editor panel instead of speaking it. Use this whenever the user asks you to write, generate, debug, fix, or add a feature to code, or when they paste code and ask for changes. Always return the FULL updated code in the code argument, not just a snippet or diff.",
    "6. build_app(html: string, title?: string) — use this whenever the user asks you to build them an app, a website, a tool, or anything they want to actually see running and interact with (not just a code snippet). The html argument must be ONE complete, self-contained HTML document starting with <!DOCTYPE html>, with all CSS in a <style> tag and all JS in a <script> tag inline — no external files, no build step, no import statements. Keep it fully working with no placeholders. This opens a live preview and a link the user can open in a new tab.",
    "When the user's request needs one of these, respond with ONLY strict JSON and nothing else, no markdown fences: ",
    '{"tool_call": {"name": "manage_tasks", "arguments": {"action": "add", "title": "..."}}}',
    "or",
    '{"tool_call": {"name": "research_idea", "arguments": {"idea": "..."}}}',
    "or",
    '{"tool_call": {"name": "remember", "arguments": {"fact": "..."}}}',
    "or",
    '{"tool_call": {"name": "open_link", "arguments": {"url": "...", "title": "..."}}}',
    "or",
    '{"tool_call": {"name": "write_code", "arguments": {"code": "...", "language": "...", "filename": "..."}}}',
    "or",
    '{"tool_call": {"name": "build_app", "arguments": {"html": "<!DOCTYPE html>...", "title": "..."}}}',
    "Otherwise just respond normally in plain conversational text. Never read code out loud or paste large code blocks into a normal spoken reply — always use write_code or build_app for that and just briefly describe what you changed.",
    "If the user asks you to explain code (e.g. 'explain this' or 'walk me through every line'), do NOT call write_code and do NOT wrap anything in triple-backtick code fences — just explain it in plain conversational prose, referencing lines by what they do rather than quoting them verbatim, going through it in order from top to bottom.",
  ];
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

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
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

// ---- Tool-call detection ----
interface ToolCall {
  name:
    | "manage_tasks"
    | "research_idea"
    | "remember"
    | "open_link"
    | "write_code"
    | "build_app";
  arguments: Record<string, any>;
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
async function manageTasks(args: Record<string, any>): Promise<string> {
  const { action, title, task_id } = args;

  if (action === "add") {
    const { error } = await supabase.from("tasks").insert({ title });
    if (error) return `Couldn't add the task: ${error.message}`;
    return `Added task: "${title}"`;
  }

  if (action === "list") {
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("status", "open")
      .order("created_at", { ascending: true });
    if (error) return `Couldn't load tasks: ${error.message}`;
    if (!data?.length) return "No open tasks.";
    return data.map((t: any) => `${t.title} (id ${t.id})`).join(", ");
  }

  if (action === "complete") {
    const { error } = await supabase
      .from("tasks")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", task_id);
    if (error) return `Couldn't complete task: ${error.message}`;
    return `Marked task ${task_id} as done.`;
  }

  if (action === "delete") {
    const { error } = await supabase.from("tasks").delete().eq("id", task_id);
    if (error) return `Couldn't delete task: ${error.message}`;
    return `Deleted task ${task_id}.`;
  }

  return "Unrecognized task action.";
}

// Runs a real, Google Search-grounded research pass on the idea, saves the
// brief (with sources) to Supabase, and opens the top source in a new tab.
// Note: because this fires after an `await`, some browsers' popup blockers
// may still swallow the window.open — that's a browser limitation, not a bug
// here. If it gets blocked, the link is still returned in the reply/brief.
async function researchIdea(args: Record<string, any>): Promise<string> {
  const { idea } = args;
  if (!idea || !String(idea).trim()) return "No idea given to research.";

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${RESEARCH_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMMA_API_KEY,
        },
        body: JSON.stringify({
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
        }),
      },
    );
    const json = await res.json();
    if (!res.ok) {
      console.error("Research error", json);
      return `Couldn't research "${idea}" right now — check the console.`;
    }

    const candidate = json.candidates?.[0];
    const summary = (candidate?.content?.parts ?? [])
      .map((p: GeminiPart) => p.text ?? "")
      .join("")
      .trim();

    const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
    const links: { uri: string; title?: string }[] = chunks
      .map((c: any) => c.web)
      .filter((w: any) => w?.uri)
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
    const { error } = await supabase
      .from("idea_research")
      .insert({ idea_text: idea, brief });
    if (error) console.error("Couldn't save research brief:", error.message);

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

// Opens a specific URL the user (or the model) names. Same popup-blocker
// caveat as above applies when this runs off a voice turn rather than a
// direct click.
async function openLink(args: Record<string, any>): Promise<string> {
  const { url, title } = args;
  if (!url || !String(url).trim()) return "No URL given to open.";
  try {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (!win) {
      return `Tried to open ${title || url}, but the browser blocked the popup — you may need to allow popups for this site.`;
    }
    return `Opened ${title || url} in a new tab.`;
  } catch (err) {
    console.error("open_link failed", err);
    return `Couldn't open ${url}.`;
  }
}

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

async function rememberFact(args: Record<string, any>): Promise<string> {
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

async function runTool(call: ToolCall): Promise<string> {
  if (call.name === "manage_tasks") return manageTasks(call.arguments);
  if (call.name === "research_idea") return researchIdea(call.arguments);
  if (call.name === "remember") return rememberFact(call.arguments);
  if (call.name === "open_link") return openLink(call.arguments);
  // write_code is intercepted in sendMessage before runTool is called,
  // since it needs to update the code editor's React state.
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
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMMA_API_KEY,
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [
              {
                text: "You clean up raw speech-to-text transcripts. Fix garbled or mis-transcribed words, remove filler ('um', 'uh', false starts, stutters), correct grammar and punctuation, and improve word choice for clarity where it helps — but keep the SAME sentence structure, the SAME context, and the SAME overall sentence, just better phrased. NEVER change the meaning, NEVER add information that wasn't there, NEVER restructure it into a different sentence or a different request, and never answer or act on the request — only polish the wording. If the transcript naturally mixes English and Kiswahili/Sheng, preserve that mix. Respond with ONLY the cleaned-up text and nothing else — no preamble, no quotes, no explanation.",
              },
            ],
          },
          contents: [{ role: "user", parts: [{ text: trimmed }] }],
        }),
      },
    );
    const json = await res.json();
    if (!res.ok) {
      console.error("Transcript refine error", json);
      return raw;
    }
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
): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMMA_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [
            { text: buildSystemInstruction(memoryFacts, conversationSummary) },
          ],
        },
        contents: history.map((m) => ({
          role: m.role,
          parts: [{ text: m.text }],
        })),
      }),
    },
  );
  const json = await res.json();
  if (!res.ok) {
    console.error(json);
    return "Something went wrong talking to the model — check the console.";
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
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMMA_API_KEY,
        },
        body: JSON.stringify({
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
        }),
      },
    );
    const json = await res.json();
    if (!res.ok) {
      console.error("Summarization error", json);
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

// ---- Gemini TTS: real Swahili/English voice, not the robotic browser one ----

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

let browserVoicesWarned = false;

function speakWithBrowserFallback(text: string) {
  if (!("speechSynthesis" in window)) return;
  if (!browserVoicesWarned) {
    console.warn(
      "Falling back to browser TTS — Gemini TTS call failed or is unavailable.",
    );
    browserVoicesWarned = true;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.speak(utterance);
}

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
                prebuiltVoiceConfig: { voiceName: "Leda" },
              },
            },
          },
        }),
      },
    );
    const json = await res.json();
    if (!res.ok) {
      console.error("Gemini TTS error", json);
      return null;
    }
    const inlineData = json.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) {
      console.error("No audio returned from Gemini TTS", json);
      return null;
    }
    const pcmBytes = base64ToUint8Array(inlineData.data);
    const wavBlob = pcmToWavBlob(pcmBytes);
    const url = URL.createObjectURL(wavBlob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    return audio;
  } catch (err) {
    console.error("Gemini TTS request failed", err);
    return null;
  }
}

// ---- Web Speech API (mic input) typings ----

interface SpeechRecognitionResultLike {
  transcript: string;
}
interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: { isFinal: boolean; 0: SpeechRecognitionResultLike };
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

function getSpeechRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Impl = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Impl) return null;
  return new Impl();
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
  "VOICE MODEL ...... GEMMA-4",
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

function playAndWait(
  audio: HTMLAudioElement | null,
  fallbackText: string,
): Promise<void> {
  return new Promise((resolve) => {
    if (audio) {
      audio.onended = () => resolve();
      audio.play();
      return;
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(fallbackText);
      utter.onend = () => resolve();
      window.speechSynthesis.speak(utter);
      return;
    }
    resolve();
  });
}

function App() {
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
  const [appLinkLabel, setAppLinkLabel] = useState("Copy link");
  const [isStreamingCode, setIsStreamingCode] = useState(false);
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [recognitionLang, setRecognitionLang] = useState<"en-US" | "sw-KE">(
    "en-US",
  );
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const telemetry = useTelemetryFeed(listening || loading);

  const [callActive, setCallActive] = useState(false);
  const [phase, setPhase] = useState<CallPhase>("idle");
  const callActiveRef = useRef(false);
  useEffect(() => {
    callActiveRef.current = callActive;
  }, [callActive]);

  useEffect(() => {
    setVoiceSupported(getSpeechRecognition() !== null);
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

    let reply = await askEngineer(apiMessages, memoryFacts, summary);
    const toolCall = tryParseToolCall(reply);
    let effectiveMemory = memoryFacts;

    if (toolCall) {
      let toolResultText: string;

      if (toolCall.name === "write_code") {
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
        // Keep the blob URL ready for the App tab, but don't switch to it —
        // the code editor is what should be visible while this is happening.
        setAppPreview((prev) => {
          if (prev.url) URL.revokeObjectURL(prev.url);
          const blob = new Blob([htmlStr], { type: "text/html" });
          return {
            html: htmlStr,
            title: title ? String(title) : "",
            url: URL.createObjectURL(blob),
          };
        });
        revealCodeInEditor(htmlStr, "html", title ? String(title) : "app.html");
        toolResultText = `Put the code for${
          title ? ` "${title}"` : " the app"
        } in the editor panel — open the App tab whenever you want to preview it or open it in a new tab.`;
      } else {
        toolResultText = await runTool(toolCall);
      }

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
      reply = await askEngineer(withToolContext, effectiveMemory, summary);
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
    const audio = await prepareSpeech(displayText);

    setMessages([...nextMessages, { role: "model", text: displayText }]);
    setLoading(false);
    setPhase("speaking");

    await playAndWait(audio, displayText);

    if (callActiveRef.current) {
      setPhase("listening");
      beginCallTurn();
    } else {
      setPhase("idle");
    }
  }

  // Listens once, resolves with the transcript (or "" if nothing usable came through).
  function listenOnce(): Promise<string> {
    return new Promise((resolve) => {
      const recognition = getSpeechRecognition();
      if (!recognition) {
        resolve("");
        return;
      }
      recognition.lang = recognitionLang;
      recognition.interimResults = true;
      recognition.continuous = true;

      let finalTranscript = "";
      let silenceTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        recognition.stop();
        resolve(finalTranscript.trim());
      };

      recognition.onresult = (event) => {
        let interim = "";
        // Only walk results from resultIndex onward — event.results
        // accumulates every segment since start(), so re-scanning from 0
        // on each callback re-appended already-finalized text and
        // duplicated it in finalTranscript.
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0].transcript;
          if (result.isFinal) {
            finalTranscript += transcript + " ";
          } else {
            interim += transcript;
          }
        }
        if (interim) console.log("Interim:", interim);
        if (finalTranscript) console.log("Final so far:", finalTranscript);
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(finish, 1500);
      };
      recognition.onerror = (event) => {
        console.error("Speech recognition error:", event);
        setListening(false);
        finish();
      };
      recognition.onend = () => {
        setListening(false);
        finish();
      };

      recognitionRef.current = recognition;
      setListening(true);
      recognition.start();
    });
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
    recognitionRef.current?.stop();
    window.speechSynthesis?.cancel();
    setPhase("idle");
  }

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop();
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
    setShowCodeEditor(true);
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

  // Panels share the right-hand slot, so opening one closes the other
  // rather than letting them stack and overlap.
  function toggleCodeEditor() {
    setShowCodeEditor((v) => !v);
    setShowAppPreview(false);
  }

  function toggleAppPreview() {
    setShowAppPreview((v) => !v);
    setShowCodeEditor(false);
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
            onClick={() => setShowHistory((v) => !v)}
            className="px-2.5 sm:px-3 py-1.5 sm:py-2 text-[9px] sm:text-[10px] font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase border border-[#1c5578] text-[#8fe3ff] hover:border-[#3ddcff] transition-colors whitespace-nowrap"
          >
            ☰ <span className="hidden sm:inline">History</span>
          </button>
          <button
            onClick={toggleCodeEditor}
            className="px-2.5 sm:px-3 py-1.5 sm:py-2 text-[9px] sm:text-[10px] font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase border border-[#1c5578] text-[#8fe3ff] hover:border-[#3ddcff] transition-colors whitespace-nowrap"
          >
            {"</>"} <span className="hidden sm:inline">Code</span>
          </button>
          <button
            onClick={toggleAppPreview}
            className="px-2.5 sm:px-3 py-1.5 sm:py-2 text-[9px] sm:text-[10px] font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase border border-[#1c5578] text-[#8fe3ff] hover:border-[#3ddcff] transition-colors whitespace-nowrap"
          >
            ▶ <span className="hidden sm:inline">App</span>
          </button>
          <button
            onClick={callActive ? endCall : startCall}
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
                onClick={() => setShowHistory(false)}
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
                onClick={() => setShowCodeEditor(false)}
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
                onClick={() => setShowAppPreview(false)}
                className="text-[#3d6b85] hover:text-[#3ddcff] text-xs"
              >
                ✕
              </button>
            </div>

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

export default App;
