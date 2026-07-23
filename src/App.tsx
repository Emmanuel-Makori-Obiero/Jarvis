import { useEffect, useRef, useState } from "react";

const GEMMA_API_KEY = import.meta.env.VITE_GEMMA_API_KEY;
const CHAT_MODEL = "gemma-4-26b-a4b-it";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

const SYSTEM_INSTRUCTION = [
  "You are Engineer, a helpful personal voice assistant.",
  "Keep replies short and conversational, like a real spoken response — usually 1-3 sentences unless the user clearly wants more detail.",
  "Never use markdown, bullet points, or numbered lists in your replies, since they will be read aloud.",
  "Match the language the user is using. If they write in English, reply in English. If they write in Kiswahili, reply in Kiswahili. If they mix English and Kiswahili (Sheng or everyday code-switching), reply naturally in that same mixed, conversational style — do not force pure formal Kiswahili unless the user is doing that themselves.",
].join(" ");

type Role = "user" | "model";
interface Message {
  role: Role;
  text: string;
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

async function askEngineer(history: Message[]): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMMA_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
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

async function speak(text: string) {
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
              parts: [
                {
                  text: `Speak slowly, calmly, and clearly, at a relaxed conversational pace: ${text}`,
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Charon" },
              },
            },
          },
        }),
      },
    );
    const json = await res.json();
    if (!res.ok) {
      console.error("Gemini TTS error", json);
      speakWithBrowserFallback(text);
      return;
    }
    const inlineData = json.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) {
      console.error("No audio returned from Gemini TTS", json);
      speakWithBrowserFallback(text);
      return;
    }
    const pcmBytes = base64ToUint8Array(inlineData.data);
    const wavBlob = pcmToWavBlob(pcmBytes);
    const url = URL.createObjectURL(wavBlob);
    const audio = new Audio(url);
    audio.play();
    audio.onended = () => URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Gemini TTS request failed", err);
    speakWithBrowserFallback(text);
  }
}

// ---- Web Speech API (mic input) typings ----

interface SpeechRecognitionResultLike {
  transcript: string;
}
interface SpeechRecognitionEventLike extends Event {
  results: { 0: { 0: SpeechRecognitionResultLike } }[];
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

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [recognitionLang, setRecognitionLang] = useState<"en-US" | "sw-KE">(
    "en-US",
  );
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVoiceSupported(getSpeechRecognition() !== null);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

    const reply = await askEngineer(nextMessages);
    setMessages([...nextMessages, { role: "model", text: reply }]);
    setLoading(false);
    speak(reply);
  }

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = getSpeechRecognition();
    if (!recognition) return;

    recognition.lang = recognitionLang;
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      sendMessage(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  return (
    <div className="min-h-screen flex flex-col bg-neutral-950 text-white">
      <header className="px-6 py-4 border-b border-neutral-800">
        <h1 className="text-xl font-bold">Engineer</h1>
        <p className="text-sm text-neutral-400">Your personal assistant</p>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <p className="text-neutral-500 text-sm">
            Say something or type below to get started.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-lg rounded-2xl px-4 py-2 ${
              m.role === "user"
                ? "ml-auto bg-blue-600"
                : "mr-auto bg-neutral-800"
            }`}
          >
            {m.text}
          </div>
        ))}
        {loading && (
          <div className="mr-auto bg-neutral-800 rounded-2xl px-4 py-2 text-neutral-400">
            Thinking...
          </div>
        )}
        <div ref={endRef} />
      </main>

      <footer className="px-6 py-4 border-t border-neutral-800 flex items-center gap-2">
        <button
          onClick={() =>
            setRecognitionLang((prev) => (prev === "en-US" ? "sw-KE" : "en-US"))
          }
          disabled={listening}
          title="Toggle voice recognition language"
          className="shrink-0 w-11 h-11 rounded-full flex items-center justify-center text-xs font-bold bg-neutral-800 disabled:opacity-30"
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
          className={`shrink-0 w-11 h-11 rounded-full flex items-center justify-center font-semibold ${
            listening ? "bg-red-600 animate-pulse" : "bg-neutral-800"
          } disabled:opacity-30`}
        >
          🎤
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendMessage(input);
          }}
          placeholder="Message Engineer..."
          className="flex-1 bg-neutral-900 rounded-full px-4 py-2 outline-none border border-neutral-800 focus:border-blue-600"
        />
        <button
          onClick={() => sendMessage(input)}
          disabled={loading || !input.trim()}
          className="shrink-0 px-4 py-2 bg-blue-600 rounded-full font-semibold disabled:opacity-30"
        >
          Send
        </button>
      </footer>
    </div>
  );
}

export default App;
