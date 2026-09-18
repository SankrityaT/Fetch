import Image from "next/image";
import { Icon } from "./icon";

/* The last thing on the page is the dog and the button. Biscuit sits, because
 * the job is done. Then the wordmark, set as large as the viewport allows, so
 * the page ends on the name rather than on a link list. */
export function Closing() {
  return (
    <>
      <section className="py-24 md:py-32">
        <div className="reveal mx-auto max-w-[900px] px-5 text-center">
          <Image
            src="/mascot/sit-happy.png"
            alt=""
            width={240}
            height={240}
            className="mx-auto size-28 object-contain"
          />
          <h2 className="mt-6 text-balance text-[clamp(2.4rem,5.4vw,4.6rem)]">
            Let your agent roll the <em className="accent pr-[0.06em] font-normal">tape</em>.
          </h2>
          <a
            href="/download?ref=footer"
            className="mt-9 inline-flex h-[52px] items-center gap-2 rounded-pill bg-fur-1 px-7 text-15 font-semibold tracking-[-0.01em] text-[#231703] shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_10px_30px_-10px_rgb(240_169_60/0.6)] transition-[background-color,transform] duration-[120ms] ease-entrance hover:bg-fur-0 active:translate-y-px"
          >
            <Icon name="download-simple" className="size-[18px]" />
            Download for Mac
          </a>
          <p className="mt-4 text-13 text-text-2">
            Free and open source. macOS 13 or later, Apple silicon or Intel.
          </p>
        </div>
      </section>

      <footer className="relative overflow-hidden border-t border-ink-3/60 bg-[#080706]">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-start justify-between gap-10 px-5 pt-14 md:px-10">
          <nav className="grid grid-cols-2 gap-x-16 gap-y-2.5 font-mono text-12 uppercase tracking-[0.08em]">
            <span className="col-span-2 mb-1 text-text-0">Fetch</span>
            {[
              ["How it works", "#how"],
              ["Agents", "#agents"],
              ["Trust", "#trust"],
              ["Privacy", "#privacy"],
              ["Source", "https://github.com/SankrityaT/Fetch"],
              ["Download", "/download?ref=footer-nav"],
            ].map(([l, h]) => (
              <a key={l} href={h} className="text-text-2 transition-colors duration-[120ms] hover:text-text-0">
                {l}
              </a>
            ))}
          </nav>
          <p className="max-w-[34ch] font-mono text-12 uppercase leading-[1.8] tracking-[0.08em] text-text-2">
            Every Fetch screen on this page is a capture of the real app.
          </p>
        </div>

        <div aria-hidden="true" className="pointer-events-none mt-10 select-none px-3 md:px-6">
          <p className="font-display text-[clamp(8rem,43.5vw,46rem)] font-extrabold leading-[0.74] tracking-[-0.06em] text-ink-2">
            Fetch
          </p>
        </div>

        <div className="relative mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-4 border-t border-ink-3/60 px-5 py-6 font-mono text-12 uppercase tracking-[0.08em] text-text-2 md:px-10">
          <span>Fetch &copy; 2026 &middot; GPL-3.0</span>
          <span>Record it. Fetch it. Ship it.</span>
        </div>
      </footer>
    </>
  );
}
