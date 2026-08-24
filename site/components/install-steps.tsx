"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";

/* The page you land on after pressing Download.
 *
 * The file is pulled through a hidden iframe pointed at /api/download, which
 * counts the click server side and 302s to the release asset.
 *
 * An iframe rather than window.location.href, which was the first attempt and
 * was wrong. Setting location works while the asset exists, because a response
 * the browser treats as a download does not navigate. The moment the asset is
 * missing, which is the state this repo is in until a release is published, the
 * browser follows the redirect to a GitHub 404 and the visitor loses the
 * instructions. An iframe cannot navigate the top document, so the failure mode
 * is an invisible 404 in a frame nobody sees, and the steps stay put.
 *
 * One shot only, guarded by a ref, because React runs effects twice in
 * development and nobody wants the file twice.
 *
 * Four steps rather than the usual three. The first three are the standard
 * macOS drag-to-Applications dance, and the fourth is the one Fetch actually
 * needs and most download pages skip: macOS will not let anything see your
 * screen until you say so, and that is a real wall between downloading this
 * and it working.
 */

const STEPS = [
  {
    n: 1,
    title: "Open Fetch.dmg",
    body: "It lands in your Downloads folder. Double click it and a window opens.",
  },
  {
    n: 2,
    title: "Drag it into Applications",
    body: "That window has Fetch on one side and a shortcut to Applications on the other. Drag one onto the other.",
  },
  {
    n: 3,
    title: "Open it from Applications",
    body: "Fetch is signed and notarised by Apple, so it opens straight away with no warning to click through.",
  },
  {
    n: 4,
    title: "Let it see your screen",
    body: "macOS blocks screen recording until you allow it. Fetch walks you through it on first launch. Microphone and camera are optional and only asked for if you use them.",
  },
];

export function InstallSteps({ dmgRef }: { dmgRef: string }) {
  const fired = useRef(false);
  const [src, setSrc] = useState<string | null>(null);
  const href = `/api/download?ref=${encodeURIComponent(dmgRef)}`;

  useEffect(() => {
    // Guard the action, not the effect. Guarding the effect looks equivalent
    // and is not: StrictMode mounts, cleans up, and mounts again, so the first
    // pass claimed the ref, the cleanup cancelled its timer, and the second
    // pass bailed on the ref it had already set. The download never fired.
    const t = setTimeout(() => {
      if (fired.current) return;
      fired.current = true;
      setSrc(href);
    }, 700);
    return () => clearTimeout(t);
  }, [href]);

  const started = src !== null;

  return (
    <>
      {src ? (
        <iframe src={src} title="Download" className="hidden" aria-hidden="true" />
      ) : null}

      <div className="flex items-center justify-center gap-2 text-13 font-semibold text-text-2">
        <Icon
          name="download-simple"
          className={`size-4 ${started ? "" : "motion-safe:animate-pulse"}`}
        />
        {started ? "Download started" : "Starting your download"}
      </div>

      <h1 className="mt-5 text-balance text-[clamp(2.25rem,4.4vw,3.75rem)]">
        Thanks. Now four{" "}
        <em className="accent pr-[0.06em] leading-[1.1]">short</em> steps.
      </h1>

      <p className="mx-auto mt-5 max-w-[52ch] text-18 leading-[1.55] text-text-1">
        Your download should be running. If nothing happened,{" "}
        <a
          href={href}
          className="text-text-0 underline decoration-fur-1 decoration-2 underline-offset-4 transition-colors duration-[120ms] ease-entrance hover:text-fur-0"
        >
          grab it manually
        </a>
        .
      </p>

      {/* Stated here rather than next to the hero button, because this is the
          moment it can actually cost someone their time. */}
      <p className="mt-4 text-13 text-text-2">
        Requires macOS 13 or later, on Apple silicon or Intel.
      </p>

      <ol className="mt-16 grid gap-6 text-left sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s) => (
          <li
            key={s.n}
            className="flex flex-col overflow-hidden rounded-panel border border-ink-3 bg-ink-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]"
          >
            <Stage n={s.n} />
            <div className="p-6">
              <h2 className="text-18">{s.title}</h2>
              <p className="mt-2 text-14 leading-[1.6] text-text-1">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

/* The illustrations. Deliberately stylised rather than screenshot-like: the
   real app icon and the real Phosphor sprite doing the work, on the brand's
   own surfaces, so nobody mistakes them for a photograph of macOS. */
function Stage({ n }: { n: number }) {
  return (
    <div className="relative grid h-[190px] place-items-center overflow-hidden border-b border-ink-3 bg-ink-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute size-[150%] opacity-[0.13] blur-[70px]"
        style={{
          background:
            "radial-gradient(closest-side, var(--color-fur-1), transparent 100%)",
        }}
      />

      {n === 1 && (
        <div className="relative flex flex-col items-center gap-3">
          <span className="rounded-pill border border-ink-3 bg-ink-2 px-3 py-1 text-11 font-semibold text-text-1">
            Downloads
          </span>
          <div className="relative">
            <AppIcon size={64} />
            <span className="absolute -bottom-1 -right-1 grid size-6 place-items-center rounded-pill border border-ink-3 bg-ink-2 text-text-1">
              <Icon name="download-simple" className="size-3.5" />
            </span>
          </div>
        </div>
      )}

      {n === 2 && (
        <div className="relative flex items-center gap-5">
          <AppIcon size={58} />
          <Icon name="arrow-right" className="size-5 text-fur-1" />
          <span className="grid size-[62px] place-items-center rounded-card border-2 border-dashed border-ink-4 text-text-2">
            <Icon name="folder" className="size-7" />
          </span>
        </div>
      )}

      {n === 3 && (
        <div className="relative w-[78%] overflow-hidden rounded-card border border-ink-3 bg-ink-2">
          {["Figma", "Fetch", "Finder"].map((name) => (
            <div
              key={name}
              className={`flex items-center gap-2.5 px-3 py-2 text-12 ${
                name === "Fetch"
                  ? "bg-fur-1 font-semibold text-[#231703]"
                  : "text-text-2"
              }`}
            >
              {name === "Fetch" ? (
                <AppIcon size={18} />
              ) : (
                <span className="size-[18px] rounded-[5px] bg-ink-3" />
              )}
              {name}
            </div>
          ))}
        </div>
      )}

      {n === 4 && (
        <div className="relative flex items-center gap-4">
          <span className="grid size-[54px] place-items-center rounded-card border border-ink-3 bg-ink-2 text-text-1">
            <Icon name="monitor" className="size-7" />
          </span>
          <Icon name="check-circle-fill" className="size-6 text-good" />
          <Image
            src="/mascot/happy.png"
            alt=""
            width={128}
            height={128}
            className="size-14 object-contain"
          />
        </div>
      )}
    </div>
  );
}

function AppIcon({ size }: { size: number }) {
  return (
    <Image
      src="/fetch-icon-1024.png"
      alt=""
      width={256}
      height={256}
      className="rounded-[22%] object-contain"
      style={{ width: size, height: size }}
    />
  );
}
