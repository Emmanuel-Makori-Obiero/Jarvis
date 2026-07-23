import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const GEMMA_API_KEY = import.meta.env.VITE_GEMMA_API_KEY;
const CHAT_MODEL = "gemma-4-26b-a4b-it";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CONV_STORAGE_KEY = "jarvis_conversations";
const MEMORY_STORAGE_KEY = "jarvis_memory";

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

function buildSystemInstruction(memoryFacts: string[]): string {
  const lines = [
    "You are Engineer, a helpful personal voice assistant.",
    "Keep replies short and conversational, like a real spoken response — usually 1-3 sentences unless the user clearly wants more detail.",
    "Never use markdown, bullet points, or numbered lists in your replies, since they will be read aloud.",
    "Match the language the user is using. If they write in English, reply in English. If they write in Kiswahili, reply in Kiswahili. If they mix English and Kiswahili (Sheng or everyday code-switching), reply naturally in that same mixed, conversational style — do not force pure formal Kiswahili unless the user is doing that themselves.",
    "When walking someone through a multi-step task (like programming or debugging), give ONE step at a time, keep it short, then explicitly ask something like 'let me know once you've done that' before moving to the next step. Never dump several steps at once during a live call.",
    "",
    "You have three tools you can call:",
    '1. manage_tasks(action: "add"|"list"|"complete"|"delete", title?: string, task_id?: string) — reads/writes the user\'s task list.',
    "2. research_idea(idea: string) — runs a business-idea research brief.",
    "3. remember(fact: string) — saves a short, durable fact about the user (their name, preferences, ongoing projects, recurring context) so you can recall it in future conversations, even new ones. Call this whenever the user shares something worth remembering long-term. Do not call it for one-off details that only matter for this exchange.",
    "When the user's request needs one of these, respond with ONLY strict JSON and nothing else, no markdown fences: ",
    '{"tool_call": {"name": "manage_tasks", "arguments": {"action": "add", "title": "..."}}}',
    "or",
    '{"tool_call": {"name": "research_idea", "arguments": {"idea": "..."}}}',
    "or",
    '{"tool_call": {"name": "remember", "arguments": {"fact": "..."}}}',
    "Otherwise just respond normally in plain conversational text.",
  ];
  if (memoryFacts.length > 0) {
    lines.push(
      "",
      "Known facts about this user you already remember: " +
        memoryFacts.join("; ") +
        ".",
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
  name: "manage_tasks" | "research_idea" | "remember";
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

// Stub — no real research pipeline wired up yet. Saves a placeholder brief
// to idea_research so the table/flow is exercised, and returns a canned summary.
async function researchIdea(args: Record<string, any>): Promise<string> {
  const { idea } = args;
  const placeholderBrief = {
    idea,
    status: "stub",
    note: "Research pipeline not implemented yet — this is a placeholder brief.",
  };
  const { error } = await supabase
    .from("idea_research")
    .insert({ idea_text: idea, brief: placeholderBrief });
  if (error) return `Couldn't save the research brief: ${error.message}`;
  return `Noted your idea "${idea}". The research pipeline isn't wired up yet, so this is just a placeholder brief for now.`;
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
  return "Unknown tool.";
}

async function askEngineer(
  history: Message[],
  memoryFacts: string[],
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
          parts: [{ text: buildSystemInstruction(memoryFacts) }],
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
  const [memoryFacts, setMemoryFacts] = useState<string[]>(() => loadMemory());
  const [showHistory, setShowHistory] = useState(false);

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
  const [phase, setPhase] = useState<
    "idle" | "listening" | "thinking" | "speaking"
  >("idle");
  const callActiveRef = useRef(false);
  useEffect(() => {
    callActiveRef.current = callActive;
  }, [callActive]);

  useEffect(() => {
    setVoiceSupported(getSpeechRecognition() !== null);
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
  }, [messages, currentConversationId]);

  function startNewConversation() {
    setCurrentConversationId(makeId());
    setMessages([]);
    setShowHistory(false);
  }

  function selectConversation(id: string) {
    const convo = conversations.find((c) => c.id === id);
    if (!convo) return;
    setCurrentConversationId(id);
    setMessages(convo.messages);
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

    let reply = await askEngineer(nextMessages, memoryFacts);
    const toolCall = tryParseToolCall(reply);
    let effectiveMemory = memoryFacts;

    if (toolCall) {
      const toolResultText = await runTool(toolCall);

      // If the model just saved a fact, pick up the fresh memory list
      // immediately so the very next reply (and future turns) reflect it.
      if (toolCall.name === "remember") {
        effectiveMemory = loadMemory();
        setMemoryFacts(effectiveMemory);
      }

      // Feed the tool result back to the model as a fresh user turn so it can
      // phrase the final spoken reply conversationally, without ever showing
      // the raw tool JSON to the person.
      const withToolContext: Message[] = [
        ...nextMessages,
        {
          role: "user",
          text: `Tool result: ${toolResultText}. Reply to the user conversationally based on this, do not mention tools or JSON.`,
        },
      ];
      reply = await askEngineer(withToolContext, effectiveMemory);
    }

    // Prepare the audio BEFORE showing the reply, so the text bubble and the
    // voice appear together instead of the text sitting there silently first.
    const audio = await prepareSpeech(reply);

    setMessages([...nextMessages, { role: "model", text: reply }]);
    setLoading(false);
    setPhase("speaking");

    await playAndWait(audio, reply);

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
    sendMessage(transcript);
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
    listenOnce().then((transcript) => {
      if (transcript) sendMessage(transcript);
    });
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

      <header className="relative px-6 py-4 border-b border-[#123047] flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{
              background: listening ? "#ff9d4d" : "#3ddcff",
              boxShadow: `0 0 10px 2px ${listening ? "#ff9d4d" : "#3ddcff"}`,
            }}
          />
          <div>
            <h1 className="text-lg tracking-[0.35em] font-bold text-[#8fe3ff]">
              J.A.R.V.I.S
            </h1>
            <p className="text-[10px] tracking-widest text-[#3d6b85] uppercase">
              Just A Rather Very Intelligent System
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right text-[10px] text-[#3d6b85] uppercase tracking-widest leading-relaxed">
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
            className="px-3 py-2 text-[10px] font-bold tracking-[0.2em] uppercase border border-[#1c5578] text-[#8fe3ff] hover:border-[#3ddcff] transition-colors"
          >
            ☰ History
          </button>
          <button
            onClick={callActive ? endCall : startCall}
            className={`px-4 py-2 text-[10px] font-bold tracking-[0.2em] uppercase border transition-colors ${
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
          <div className="absolute inset-y-0 left-0 w-72 z-30 bg-[#03060a]/95 border-r border-[#123047] backdrop-blur-sm flex flex-col p-4 gap-2 overflow-y-auto">
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
          <main className="relative flex-1 overflow-y-auto px-6 py-5 space-y-3">
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
                          stroke={
                            phase === "thinking"
                              ? "#ffb35d"
                              : phase === "speaking"
                                ? "#6dffb0"
                                : "#3ddcff"
                          }
                          strokeWidth={long ? 2 : 1}
                          opacity={long ? 0.8 : 0.35}
                        />
                      );
                    })}
                  </svg>
                  <svg
                    viewBox="0 0 200 200"
                    className={`absolute inset-0 ${
                      phase === "thinking" ? "hud-sweep-fast" : "hud-sweep"
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
                          stopColor={
                            phase === "thinking"
                              ? "#ffb35d"
                              : phase === "speaking"
                                ? "#6dffb0"
                                : "#3ddcff"
                          }
                          stopOpacity="0"
                        />
                        <stop
                          offset="100%"
                          stopColor={
                            phase === "thinking"
                              ? "#ffb35d"
                              : phase === "speaking"
                                ? "#6dffb0"
                                : "#3ddcff"
                          }
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
                      borderColor:
                        phase === "thinking"
                          ? "#ffb35d66"
                          : phase === "speaking"
                            ? "#6dffb066"
                            : "#3ddcff66",
                    }}
                  />
                  <div
                    className={`w-20 h-20 rounded-full border flex items-center justify-center text-[10px] tracking-widest ${
                      phase === "thinking" ? "hud-core-fast" : "hud-core"
                    }`}
                    style={{
                      background:
                        phase === "thinking"
                          ? "#ffb35d1a"
                          : phase === "speaking"
                            ? "#6dffb01a"
                            : "#3ddcff1a",
                      borderColor:
                        phase === "thinking"
                          ? "#ffb35d"
                          : phase === "speaking"
                            ? "#6dffb0"
                            : "#3ddcff",
                      color:
                        phase === "thinking"
                          ? "#ffb35d"
                          : phase === "speaking"
                            ? "#6dffb0"
                            : "#8fe3ff",
                    }}
                  >
                    {phase.toUpperCase()}
                  </div>
                </div>
                <p className="text-[#3d6b85] text-xs tracking-widest uppercase max-w-sm text-center px-6">
                  {phase === "listening" &&
                    "Listening — speak naturally, pause when done"}
                  {phase === "thinking" && "Processing your request"}
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
                  className={`max-w-lg px-4 py-3 text-sm leading-relaxed border backdrop-blur-sm ${
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

          <footer className="relative px-6 py-4 border-t border-[#123047] flex items-center gap-3">
            <button
              onClick={() =>
                setRecognitionLang((prev) =>
                  prev === "en-US" ? "sw-KE" : "en-US",
                )
              }
              disabled={listening}
              title="Toggle voice recognition language"
              className="shrink-0 w-11 h-11 border border-[#1c5578] flex items-center justify-center text-[10px] font-bold text-[#8fe3ff] bg-[#0a0f14] disabled:opacity-30 hover:border-[#3ddcff] transition-colors"
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
              className="relative shrink-0 w-14 h-14 rounded-full flex items-center justify-center disabled:opacity-30"
            >
              <span
                className={`absolute inset-0 rounded-full border ${
                  listening
                    ? "border-[#ff9d4d] hud-ring-fast"
                    : "border-[#3ddcff]/40"
                }`}
              />
              <span
                className={`w-9 h-9 rounded-full flex items-center justify-center text-lg ${
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
              className="flex-1 bg-[#0a0f14] border border-[#123047] px-4 py-2.5 text-sm text-[#e8f6ff] placeholder-[#2d4f63] outline-none focus:border-[#3ddcff] transition-colors tracking-wide"
            />

            <button
              onClick={() => sendMessage(input)}
              disabled={loading || !input.trim()}
              className="shrink-0 px-5 py-2.5 border border-[#3ddcff] text-[#3ddcff] text-xs font-bold tracking-[0.2em] uppercase hover:bg-[#3ddcff]/10 transition-colors disabled:opacity-30"
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
        .clip-panel-user { clip-path: polygon(0 0, 100% 0, 100% 100%, 12px 100%, 0 calc(100% - 12px)); }
        .clip-panel-model { clip-path: polygon(12px 0, 100% 0, 100% 100%, 0 100%, 0 12px); }
      `}</style>
    </div>
  );
}

export default App;
