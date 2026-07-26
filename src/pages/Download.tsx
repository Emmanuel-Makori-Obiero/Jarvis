import { useEffect, useState, type ReactElement } from "react";

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type GithubRelease = {
  tag_name: string;
  name: string;
  published_at: string;
  assets: ReleaseAsset[];
};

type Platform = {
  id: "windows" | "mac" | "android" | "ios";
  name: string;
  detail: string;
  fallbackHref: string;
  icon: ReactElement;
  matchers: RegExp[];
};

const REPO = "Emmanuel-Makori-Obiero/Jarvis";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;

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
    fallbackHref: "https://play.google.com/",
    icon: <WindowsIcon />,
    matchers: [/\.exe$/i, /win.*\.zip$/i],
  },
  {
    id: "mac",
    name: "Jarvis for Mac",
    detail: "macOS 12 Monterey and later, Apple silicon or Intel",
    fallbackHref: "",
    icon: <AppleIcon />,
    matchers: [/\.dmg$/i, /mac.*\.zip$/i],
  },
  {
    id: "android",
    name: "Jarvis for Android",
    detail: "Android 9 and later",
    fallbackHref:
      "https://play.google.com/store/apps/details?id=com.jarvis.app",
    icon: <AndroidIcon />,
    matchers: [/\.apk$/i],
  },
  {
    id: "ios",
    name: "Jarvis for iOS",
    detail: "iOS 16 and later, iPhone and iPad",
    fallbackHref: "https://apps.apple.com/app/jarvis/id0000000000",
    icon: <AppleIcon />,
    matchers: [/\.ipa$/i],
  },
];

function formatSize(bytes: number) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function findAsset(assets: ReleaseAsset[], matchers: RegExp[]) {
  return assets.find((asset) =>
    matchers.some((pattern) => pattern.test(asset.name)),
  );
}

export default function Download() {
  const [releases, setReleases] = useState<GithubRelease[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openPlatform, setOpenPlatform] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } })
      .then((res) => {
        if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
        return res.json() as Promise<GithubRelease[]>;
      })
      .then((data) => {
        if (!cancelled) {
          setReleases(data);
          setLoadState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setLoadState("error");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopyLink = async (id: string, href: string) => {
    try {
      await navigator.clipboard.writeText(href);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // clipboard unavailable, ignore
    }
  };

  const latestRelease = releases[0];

  return (
    <section className="min-h-screen bg-neutral-950 text-neutral-100 px-6 py-16 sm:py-24">
      <div className="mx-auto max-w-4xl">
        <p className="text-sm tracking-wide text-cyan-400 font-mono mb-3">
          Get Jarvis
        </p>
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-4">
          Download Jarvis for your device
        </h1>
        <p className="text-neutral-400 max-w-xl mb-2">
          One assistant, every screen. Pick a platform below and you'll be up
          and running in a couple of minutes.
        </p>
        <p className="text-xs font-mono text-neutral-600 mb-12">
          {loadState === "loading" && "Checking releases…"}
          {loadState === "ready" &&
            latestRelease &&
            `Latest release ${latestRelease.tag_name}`}
          {loadState === "ready" &&
            !latestRelease &&
            "No releases published yet"}
          {loadState === "error" && "Could not reach GitHub right now"}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {platforms.map((platform) => {
            const latestAsset = latestRelease
              ? findAsset(latestRelease.assets, platform.matchers)
              : undefined;
            const isDesktop =
              platform.id === "windows" || platform.id === "mac";
            const isStoreApp =
              platform.id === "android" || platform.id === "ios";
            const isOpen = openPlatform === platform.id;

            const olderMatches = isDesktop
              ? releases
                  .map((release) => ({
                    release,
                    asset: findAsset(release.assets, platform.matchers),
                  }))
                  .filter((entry) => entry.asset)
              : [];

            return (
              <div
                key={platform.id}
                className="group relative rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 transition-colors hover:border-cyan-500/60"
              >
                <div className="flex items-start justify-between mb-6">
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-neutral-800 text-neutral-200 group-hover:text-cyan-400 transition-colors">
                    {platform.icon}
                  </div>
                  <span className="text-xs font-mono text-neutral-500">
                    {latestAsset
                      ? latestRelease.tag_name
                      : isStoreApp
                        ? "store"
                        : "—"}
                  </span>
                </div>

                <h2 className="text-lg font-medium mb-1">{platform.name}</h2>
                <p className="text-sm text-neutral-400 mb-6">
                  {platform.detail}
                </p>

                <div className="flex items-center gap-3">
                  {latestAsset ? (
                    <a
                      href={latestAsset.browser_download_url}
                      className="inline-flex items-center justify-center rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-cyan-400 transition-colors"
                    >
                      Download
                    </a>
                  ) : isStoreApp ? (
                    <a
                      href={platform.fallbackHref}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-cyan-400 transition-colors"
                    >
                      Get the app
                    </a>
                  ) : (
                    <span className="inline-flex items-center justify-center rounded-lg border border-neutral-800 px-4 py-2 text-sm font-medium text-neutral-500">
                      Not available yet
                    </span>
                  )}

                  {latestAsset && (
                    <span className="text-xs text-neutral-500 font-mono">
                      {formatSize(latestAsset.size)}
                    </span>
                  )}

                  {latestAsset && (
                    <button
                      type="button"
                      onClick={() =>
                        handleCopyLink(
                          platform.id,
                          latestAsset.browser_download_url,
                        )
                      }
                      className="ml-auto text-xs text-neutral-500 hover:text-neutral-200 transition-colors"
                    >
                      {copiedId === platform.id ? "Link copied" : "Copy link"}
                    </button>
                  )}
                </div>

                {isDesktop && olderMatches.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-neutral-800">
                    <button
                      type="button"
                      onClick={() =>
                        setOpenPlatform(isOpen ? null : platform.id)
                      }
                      className="text-xs text-neutral-400 hover:text-cyan-400 transition-colors"
                    >
                      {isOpen
                        ? "Hide other versions"
                        : `View releases (${olderMatches.length})`}
                    </button>

                    {isOpen && (
                      <ul className="mt-3 space-y-2">
                        {olderMatches.map(({ release, asset }) => (
                          <li
                            key={release.tag_name}
                            className="flex items-center justify-between text-sm rounded-lg bg-neutral-950/60 px-3 py-2"
                          >
                            <div className="flex flex-col">
                              <span className="font-mono text-neutral-200">
                                {release.tag_name}
                              </span>
                              <span className="text-xs text-neutral-500">
                                {formatDate(release.published_at)} ·{" "}
                                {formatSize(asset!.size)}
                              </span>
                            </div>
                            <a
                              href={asset!.browser_download_url}
                              className="text-xs text-cyan-400 hover:text-cyan-300 font-medium"
                            >
                              Download
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
