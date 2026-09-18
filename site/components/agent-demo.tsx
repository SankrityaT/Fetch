"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icon";

/* The hero is a run, not a picture of one.
 *
 * Every row below is a real Fetch MCP tool, and every result is what that tool
 * returned for the take in the editor on the right: an agent recorded the
 * policy test, transcribe came back with 34 words on this Mac, list_beats named
 * B1 to B4 from what was said, and apply_edit put Z1 at 1.8x on B2, the beat
 * where 1Password gets refused. The editor is a capture of the app holding that
 * exact take, not a mockup of one.
 *
 * The terminal starts centred and slides left when the app arrives, the way
 * your attention actually moves: you watch the agent, then you look at what it
 * made. Transform only, measured once per resize, so nothing reflows. */

const PROMPT =
  "Record the policy test in my terminal, caption it, and zoom in where it refuses 1Password";

const ROWS = [
  { tool: "list_windows", did: "Found the terminal" },
  { tool: "record_start", did: "Recording that window, nothing else" },
  { tool: "record_stop", did: "17 seconds, saved to your Desktop" },
  { tool: "transcribe", did: "34 words, transcribed on this Mac" },
  { tool: "list_beats", did: "B1 to B4, named from what was said" },
  { tool: "apply_edit", did: "Z1 at 1.8× on B2" },
];

const TYPE_MS = 24;
const START = 500;
const typedAt = START + PROMPT.length * TYPE_MS;
const rowAt = (i: number) => typedAt + 450 + i * 620;
const doneAt = rowAt(ROWS.length) + 150;
const appAt = doneAt + 350;
const END = appAt + 900;

export function AgentDemo() {
  const [t, setT] = useState(0);
  const [shift, setShift] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<HTMLDivElement>(null);
  const raf = useRef(0);

  const play = useCallback(() => {
    cancelAnimationFrame(raf.current);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setT(END);
      return;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const e = now - t0;
      setT(e);
      if (e < END) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    play();
    return () => cancelAnimationFrame(raf.current);
  }, [play]);

  /* How far the terminal sits from its resting place while it is alone:
     half the free space, so it reads as centred. Zero below lg, where the
     two stack and nothing slides. */
  useLayoutEffect(() => {
    const measure = () => {
      const b = box.current, m = term.current;
      if (!b || !m) return;
      const wide = window.matchMedia("(min-width: 1024px)").matches;
      setShift(wide ? (b.clientWidth - m.clientWidth) / 2 : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const typed = PROMPT.slice(0, Math.max(0, Math.floor((t - START) / TYPE_MS)));
  const typing = t < typedAt;
  const app = t >= appAt;
  const done = t >= doneAt;

  return (
    <div ref={box} className="relative lg:h-[600px]">
      {/* ── the agent ───────────────────────────────────────────────── */}
      <div
        ref={term}
        className="relative z-20 w-full lg:absolute lg:left-0 lg:top-[92px] lg:w-[440px]"
        style={{
          transform: `translate3d(${app ? 0 : shift}px,0,0)`,
          transition: "transform 900ms cubic-bezier(.2,.8,.2,1)",
        }}
      >
        <div className="floating overflow-hidden rounded-panel bg-[#171412]/95 backdrop-blur-md">
          <div className="flex h-10 items-center gap-2 border-b border-white/[0.06] px-4">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
            <span className="ml-auto mr-auto flex items-center gap-2 pr-12 text-13 font-semibold text-text-1">
              <span className="grid size-5 place-items-center rounded-[6px] bg-ink-2">
                <Image src="/agents/claude.svg" alt="" width={14} height={14} />
              </span>
              Claude Code
            </span>
          </div>

          <div className="p-4">
            <div className="rounded-card bg-white/[0.04] px-4 py-3 font-mono text-13 leading-[1.6] text-text-0 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
              <span className="text-fur-1">&gt;</span> {typed}
              {typing ? (
                <span className="ml-px inline-block h-[1.05em] w-[0.55em] translate-y-[2px] bg-text-0 motion-safe:animate-[caret_1s_steps(1)_infinite]" />
              ) : null}
            </div>

            <ol className="mt-2">
              {ROWS.map((r, i) => {
                const on = t >= rowAt(i);
                const ok = t >= rowAt(i) + 380;
                return (
                  <li
                    key={r.tool}
                    className="flex items-center gap-3 px-1 py-[7px] transition-[opacity,transform] duration-[320ms] ease-entrance"
                    style={{
                      opacity: on ? 1 : 0,
                      transform: on ? "none" : "translate3d(0,6px,0)",
                    }}
                  >
                    <Image
                      src="/fetch-icon-1024.png"
                      alt=""
                      width={56}
                      height={56}
                      className="size-7 shrink-0 rounded-[7px]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-12 text-text-2">{r.tool}</span>
                      <span className="block truncate text-13 text-text-0">{r.did}</span>
                    </span>
                    <span
                      className={[
                        "grid size-5 shrink-0 place-items-center rounded-full transition-colors duration-[200ms]",
                        ok ? "bg-good/15 text-good" : "text-text-2",
                      ].join(" ")}
                    >
                      <Icon
                        name={ok ? "check" : "spinner-gap"}
                        className={`size-3.5 ${ok ? "" : "motion-safe:animate-spin"}`}
                      />
                    </span>
                  </li>
                );
              })}
            </ol>

            <p
              className="mt-2 flex items-center gap-2 px-1 font-mono text-13 text-text-0 transition-opacity duration-[320ms]"
              style={{ opacity: done ? 1 : 0 }}
            >
              <span className="size-1.5 rounded-full bg-good" />
              Done. It is open in Fetch.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={play}
          className="mx-auto mt-4 flex h-9 items-center gap-2 rounded-pill bg-white/[0.08] px-4 text-13 font-semibold text-text-0 backdrop-blur-md transition-[background-color,opacity] duration-[200ms] ease-entrance hover:bg-white/[0.14]"
          style={{ opacity: t >= END ? 1 : 0, pointerEvents: t >= END ? "auto" : "none" }}
        >
          <Icon name="arrow-counter-clockwise" className="size-4" />
          Replay
        </button>
      </div>

      {/* ── what it made ────────────────────────────────────────────── */}
      <div
        className="relative z-10 mt-6 lg:absolute lg:right-0 lg:top-0 lg:mt-0 lg:w-[76%]"
        style={{
          opacity: app ? 1 : 0,
          transform: app ? "none" : "translate3d(40px,0,0) scale(.985)",
          transition: "opacity 700ms cubic-bezier(.2,.8,.2,1), transform 900ms cubic-bezier(.2,.8,.2,1)",
        }}
      >
        <div className="floating overflow-hidden rounded-panel bg-ink-1">
          <Image
            src="/shots/v2/editor.png"
            alt="The Fetch editor holding the take the agent made: a terminal running the policy test on the Dusk backdrop, the caption 'it is refused, in every mode.' burned in, beats B1 to B4 named from speech, and zoom Z1 on beat B2."
            width={2880}
            height={1778}
            sizes="(max-width: 1024px) 94vw, 900px"
            className="block h-auto w-full"
            preload
          />
        </div>
      </div>
    </div>
  );
}
