"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { Icon } from "./icon";

/* The hero says it is a full editor. This section is where that gets proved.
 *
 * One window, one pinned frame, and a segmented control that swaps which
 * inspector pane is open. Every frame is a real capture of the running app
 * with the playhead parked at the same timestamp, so moving between tabs
 * changes the inspector and nothing else. That only reads as honest if the
 * captures are consistent, which is why they were shot that way rather than
 * cropped together afterwards.
 *
 * The control is the app's own `.seg`: the same pill, the same 3px inset, the
 * same --ink-3 fill on the selected item as the Record / Library / Edit
 * switcher in the titlebar.
 *
 * There is no Zoom tab, and that is deliberate rather than an oversight. The
 * look panel switches the stage to the backdrop composite, which would not
 * paint a frame under capture across three attempts, so the shot came out with
 * a black canvas while the other three showed content. A tab that looks broken
 * next to three that do not is worse than one fewer tab. Auto zoom is still
 * claimed in the hero, and it gets its own section when there is a recording
 * with a real cursor track to show it on.
 */

const TABS = [
  {
    id: "trim",
    label: "Trim",
    icon: "scissors",
    line: "Set the range, cut a section out of the middle, or let it find the silent gaps for you.",
  },
  {
    id: "captions",
    label: "Captions",
    icon: "closed-captioning",
    line: "Transcribed on your Mac in seconds. Edit the cues, restyle them, then burn them in.",
  },
  {
    id: "audio",
    label: "Audio",
    icon: "waveform",
    line: "Denoise, normalise loudness, and a second track you can mix under or swap in.",
  },
] as const;

export function EditorTabs() {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /* A tablist is arrow-key navigable or it is not a tablist. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (active + delta + TABS.length) % TABS.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section id="editor" className="relative scroll-mt-24 border-t border-ink-3/60 py-24 lg:py-32">
      <div className="mx-auto max-w-[1200px] px-6 md:px-10">
        <div className="mx-auto max-w-[46rem] text-center">
          {/* "A real editor, not a share link" was an X-not-Y construction,
              which is a tell. The section's job is the work that happens after
              you stop recording, so the headline just says that. */}
          <h2 className="text-[clamp(2rem,3.6vw,3.25rem)]">
            Everything you need after you hit{" "}
            <em className="accent pr-[0.06em] leading-[1.1]">stop</em>.
          </h2>
          <p className="mx-auto mt-5 max-w-[46ch] text-18 leading-[1.55] text-text-1">
            Trim, caption and mix on one timeline, then export to MP4, WebM,
            GIF or audio only.
          </p>
        </div>

        {/* .seg, rebuilt to the app's spec: 3px inset, 2px gap, pill, and the
            selected item lifted with --ink-3 plus the sheen */}
        <div
          role="tablist"
          aria-label="Editor panels"
          onKeyDown={onKeyDown}
          className="mx-auto mt-10 flex w-max max-w-full gap-[2px] overflow-x-auto rounded-pill border border-ink-3 bg-ink-1 p-[3px]"
        >
          {TABS.map((tab, i) => (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={i === active}
              aria-controls="editor-panel"
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              className={[
                "inline-flex h-9 shrink-0 items-center gap-2 rounded-pill px-4 text-13 font-semibold",
                "transition-[background-color,color] duration-[120ms] ease-entrance",
                i === active
                  ? "bg-ink-3 text-text-0 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]"
                  : "text-text-1 hover:text-text-0",
              ].join(" ")}
            >
              <Icon name={tab.icon} className="size-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id="editor-panel"
          aria-labelledby={`tab-${TABS[active].id}`}
          className="mt-10"
        >
          {/* Same bezel as the hero frame: 20px shell, 6px inset, 14px core. */}
          <div className="rounded-panel border border-ink-3 bg-ink-1 p-1.5 shadow-[0_40px_100px_-30px_rgb(0_0_0/0.9),inset_0_1px_0_rgb(255_255_255/0.05)]">
            {/* Below lg the whole window is ~318px of unreadable mush, the same
                problem the hero has. The hero crops to the canvas; this section
                cannot, because the thing that changes between tabs is the
                inspector. So the mobile crop keeps the right 40%: the tool
                rail, the panel, and the Export button, which is enough app
                chrome to still read as an app. */}
            <div className="relative aspect-[31/50] overflow-hidden rounded-card lg:aspect-[2480/1600]">
              <div className="absolute inset-y-0 left-0 ml-[-150%] w-[250%] lg:m-0 lg:w-full">
              {TABS.map((tab, i) => (
                <Image
                  key={tab.id}
                  src={`/shots/tabs/${tab.id}.png`}
                  alt={`The Fetch editor with the ${tab.label.toLowerCase()} panel open.`}
                  fill
                  sizes="(max-width: 1024px) 250vw, 1180px"
                  className={[
                    "object-cover transition-opacity duration-[200ms] ease-entrance",
                    i === active ? "opacity-100" : "opacity-0",
                  ].join(" ")}
                  /* all four sit in the DOM so switching is instant, but only
                     the one you land on is worth fetching eagerly */
                  loading={i === 0 ? "eager" : "lazy"}
                  aria-hidden={i !== active}
                />
              ))}
              </div>
            </div>
          </div>

          <p className="mx-auto mt-6 max-w-[62ch] text-center text-15 leading-[1.6] text-text-1">
            {TABS[active].line}
          </p>
        </div>
      </div>
    </section>
  );
}
