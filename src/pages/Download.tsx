import { useState } from "react";

type Platform = {
  id: string;
  name: string;
  detail: string;
  version: string;
  size: string;
  href: string;
  icon: JSX.Element;
};

const WindowsIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="28"
    height="28"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
  >
    <path d="M3 5.5 10.5 4.4V11H3V5.5Z" />
    <path d="M11.5 4.3 21 3v8H11.5V4.3Z" />
    <path d="M3 12h7.5v6.6L3 17.5V12Z" />
    <path d="M11.5 12H21v8l-9.5-1.3V12Z" />
  </svg>
);

const AppleIcon = () => (
  <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
    <path d="M16.365 1.43c0 1.14-.468 2.11-1.257 2.85-.86.81-2.06 1.44-3.19 1.35-.14-1.1.45-2.24 1.24-2.95.83-.75 2.15-1.29 3.2-1.25ZM20.5 17.24c-.55 1.27-.81 1.84-1.52 2.96-.99 1.56-2.38 3.5-4.11 3.51-1.53.02-1.92-1-4-1-2.07 0-2.51.98-4.02 1-1.66.02-2.93-1.77-3.92-3.33-2.68-4.21-2.96-9.15-1.31-11.79 1.17-1.87 3.02-2.96 4.75-2.96 1.76 0 2.87 1.06 4.33 1.06 1.42 0 2.28-1.06 4.32-1.06 1.55 0 3.19.85 4.36 2.31-3.83 2.1-3.21 7.56 1.12 9.3Z" />
  </svg>
);

const AndroidIcon = () => (
  <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
    <path d="M6.5 8.5v6.7a1 1 0 0 0 1 1h1v3.3a1.3 1.3 0 0 0 2.6 0v-3.3h1.8v3.3a1.3 1.3 0 0 0 2.6 0v-3.3h1a1 1 0 0 0 1-1V8.5H6.5Z" />
    <path d="M6.9 7.3h10.2c-.2-1.9-1.4-3.5-3.1-4.3l.85-1.4a.4.4 0 0 0-.68-.42l-.9 1.47a5.7 5.7 0 0 0-3.55 0L8.83 1.15a.4.4 0 0 0-.68.42l.85 1.4c-1.7.8-2.9 2.4-3.1 4.3Z" />
    <circle cx="9.3" cy="5.6" r=".55" />
    <circle cx="14.7" cy="5.6" r=".55" />
    <path d="M4.7 8.9a1.1 1.1 0 0 0-1.1 1.1v4.2a1.1 1.1 0 1 0 2.2 0v-4.2a1.1 1.1 0 0 0-1.1-1.1ZM19.3 8.9a1.1 1.1 0 0 0-1.1 1.1v4.2a1.1 1.1 0 1 0 2.2 0v-4.2a1.1 1.1 0 0 0-1.1-1.1Z" />
  </svg>
);

const platforms: Platform[] = [
  {
    id: "windows",
    name: "Jarvis for Windows",
    detail: "Windows 10 and later, 64-bit",
    version: "v1.0.0",
    size: "86 MB",
    href: "/downloads/jarvis-setup-win.exe",
    icon: <WindowsIcon />,
  },
  {
    id: "mac",
    name: "Jarvis for Mac",
    detail: "macOS 12 Monterey and later, Apple silicon or Intel",
    version: "v1.0.0",
    size: "92 MB",
    href: "/downloads/jarvis-mac.dmg",
    icon: <AppleIcon />,
  },
  {
    id: "android",
    name: "Jarvis for Android",
    detail: "Android 9 and later",
    version: "v1.0.0",
    size: "38 MB",
    href: "https://play.google.com/store/apps/details?id=com.jarvis.app",
    icon: <AndroidIcon />,
  },
  {
    id: "ios",
    name: "Jarvis for iOS",
    detail: "iOS 16 and later, iPhone and iPad",
    version: "v1.0.0",
    size: "41 MB",
    href: "https://apps.apple.com/app/jarvis/id0000000000",
    icon: <AppleIcon />,
  },
];

export default function Download() {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyLink = async (platform: Platform) => {
    try {
      await navigator.clipboard.writeText(
        window.location.origin + platform.href,
      );
      setCopiedId(platform.id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // clipboard unavailable, ignore
    }
  };

  return (
    <section className="min-h-screen bg-neutral-950 text-neutral-100 px-6 py-16 sm:py-24">
      <div className="mx-auto max-w-4xl">
        <p className="text-sm tracking-wide text-cyan-400 font-mono mb-3">
          Get Jarvis
        </p>
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-4">
          Download Jarvis for your device
        </h1>
        <p className="text-neutral-400 max-w-xl mb-12">
          One assistant, every screen. Pick a platform below and you'll be up
          and running in a couple of minutes.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {platforms.map((platform) => (
            <div
              key={platform.id}
              className="group relative rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 transition-colors hover:border-cyan-500/60"
            >
              <div className="flex items-start justify-between mb-6">
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-neutral-800 text-neutral-200 group-hover:text-cyan-400 transition-colors">
                  {platform.icon}
                </div>
                <span className="text-xs font-mono text-neutral-500">
                  {platform.version}
                </span>
              </div>

              <h2 className="text-lg font-medium mb-1">{platform.name}</h2>
              <p className="text-sm text-neutral-400 mb-6">{platform.detail}</p>

              <div className="flex items-center gap-3">
                <a
                  href={platform.href}
                  className="inline-flex items-center justify-center rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-cyan-400 transition-colors"
                >
                  Download
                </a>
                <span className="text-xs text-neutral-500 font-mono">
                  {platform.size}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopyLink(platform)}
                  className="ml-auto text-xs text-neutral-500 hover:text-neutral-200 transition-colors"
                >
                  {copiedId === platform.id ? "Link copied" : "Copy link"}
                </button>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-10 text-xs text-neutral-600">
          Looking for release notes or older versions? Check the{" "}
          <a href="/releases" className="underline hover:text-neutral-300">
            releases page
          </a>
          .
        </p>
      </div>
    </section>
  );
}
