import Image from "next/image";
import { Icon } from "./icon";

/* What Fetch records, said about Fetch alone. It is free and open source and
 * has nothing to win by naming anyone else, so this section shows the range
 * instead of a comparison: every kind of window on a Mac is fair game, because
 * the capture is ScreenCaptureKit on the real machine rather than a browser or
 * a page drawn for the purpose. */
const KINDS = [
  { icon: "app-window", title: "Native apps", eg: "Xcode, Figma, Notion, the app you are building" },
  { icon: "monitor", title: "Terminals", eg: "Terminal, iTerm, Ghostty, a test run as it happens" },
  { icon: "cursor-text", title: "Editors", eg: "VS Code, Cursor, Zed, with the diff on screen" },
  { icon: "link-simple", title: "Browsers", eg: "Chrome, Safari, Arc, or one Playwright opened" },
];

export function RealMachine() {
  return (
    <section className="py-20 md:py-28">
      <div className="mx-auto max-w-[1240px] px-5 md:px-10">
        <div className="reveal relative mx-auto max-w-[1080px] rounded-[28px] border border-dashed border-ink-3 px-6 py-16 md:px-16 md:py-20">
          <div className="text-center">
            <Image
              src="/mascot/curious.png"
              alt=""
              width={160}
              height={160}
              className="mx-auto size-20 object-contain"
            />
            <h2 className="mt-6 text-balance text-[clamp(2.2rem,4.6vw,4rem)]">
              It records the <em className="accent pr-[0.06em] font-normal">real</em> thing.
            </h2>
            <p className="mx-auto mt-5 max-w-[54ch] text-18 leading-[1.55] text-text-1">
              Whatever window is open on your Mac, an agent can record it. One
              window on its own, or the whole screen.
            </p>
          </div>

          <ul className="mx-auto mt-12 grid max-w-[900px] gap-3 sm:grid-cols-2">
            {KINDS.map((k) => (
              <li key={k.title} className="flex items-start gap-4 rounded-[18px] raised px-5 py-5">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-ink-2 text-fur-1">
                  <Icon name={k.icon} className="size-5" />
                </span>
                <span>
                  <span className="block text-18 font-semibold tracking-[-0.01em] text-text-0">
                    {k.title}
                  </span>
                  <span className="mt-1 block text-15 leading-[1.5] text-text-2">{k.eg}</span>
                </span>
              </li>
            ))}
          </ul>

          <p className="mx-auto mt-8 max-w-[52ch] text-center text-15 text-text-2">
            The iOS Simulator too. It is just a window. Fetch records, and whatever
            drives the app, Playwright, <span className="font-mono text-13 text-text-1">simctl</span> or
            you, stays in charge of it.
          </p>
        </div>
      </div>
    </section>
  );
}
