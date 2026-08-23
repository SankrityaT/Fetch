import { CameraBubble } from "./camera-bubble";
import { Icon } from "./icon";

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      <div className="mx-auto grid max-w-[1400px] items-center gap-14 px-6 pb-24 pt-28 md:px-10 lg:min-h-dvh lg:grid-cols-12 lg:gap-10 lg:pb-24 lg:pt-28">
        {/* ── the argument ────────────────────────────────────────────── */}
        <div className="lg:col-span-7">
          {/* Nobody goes looking for a screen recorder because of where the
              webcam sits. They go looking because Loom wants $20 a month and
              uploads their screen. So the hero is the category and the reason
              to switch, and the camera trick is one clause in the subtext,
              which is the weight it actually carries.

              No price claim here on purpose: pricing is undecided, and "no
              subscription" is as far as the brief lets us commit. */}
          <h1
            className="rise text-[clamp(2.4rem,4.9vw,4.4rem)]"
            style={{ ["--i" as string]: 0 }}
          >
            <span className="sm:block">Record your screen. </span>
            <span className="sm:block">
              Keep it on your{" "}
              <em className="accent pr-[0.06em] leading-[1.1]">Mac</em>.
            </span>
          </h1>

          <p
            className="rise mt-6 max-w-[50ch] text-24 leading-[1.4] text-text-1"
            style={{ ["--i" as string]: 1 }}
          >
            A full editor with captions, auto zoom and a movable camera. No
            account, no upload, no subscription.
          </p>

          <div
            className="rise mt-9 flex flex-wrap items-center gap-3"
            style={{ ["--i" as string]: 2 }}
          >
            {/* .btn-primary, lifted straight out of the app: gold pill, ink
                label, hover washes to --fur-0, active presses down 1px */}
            <a
              href="/download?ref=hero"
              className="group inline-flex h-[46px] items-center gap-2 rounded-pill border border-fur-1 bg-fur-1 px-6 text-15 font-semibold tracking-[-0.01em] text-[#231703] shadow-[inset_0_1px_0_rgb(255_255_255/0.14)] transition-[background-color,border-color,transform] duration-[120ms] ease-entrance hover:border-fur-0 hover:bg-fur-0 active:translate-y-px"
            >
              <Icon name="download-simple" className="size-[18px]" />
              Download for Mac
            </a>

            {/* .btn, the neutral sibling */}
            <a
              href="#editor"
              className="inline-flex h-[46px] items-center gap-2 rounded-pill border border-ink-3 bg-ink-2 px-5 text-15 font-semibold tracking-[-0.01em] text-text-0 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] transition-[background-color,border-color,transform] duration-[120ms] ease-entrance hover:border-ink-4 hover:bg-ink-3 active:translate-y-px"
            >
              See the editor
              <Icon name="arrow-right" className="size-4 text-text-1" />
            </a>
          </div>
        </div>

        {/* ── the proof ───────────────────────────────────────────────────
            Not a picture of the editor. The editor, with the one thing no
            other recorder does live on top of it. */}
        <div
          className="rise relative lg:col-span-5 lg:-mr-[18vw] xl:-mr-[15vw]"
          style={{ ["--i" as string]: 3 }}
        >
          {/* The room is dark and the screen is the only thing lighting it.
              The glow sits behind the frame and reads as spill off its edges,
              which is the only reason it is allowed to be here at all. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -left-[14%] -right-[14%] -bottom-[14%] -top-[70%] -z-10 opacity-[0.15] blur-[110px]"
            style={{
              background:
                "radial-gradient(closest-side, var(--color-fur-1) 0%, var(--color-fur-2) 55%, transparent 100%)",
            }}
          />
          {/* Double bezel in the app's own radii: 20px shell, 6px inset,
              14px core. Elevation is light, not shadow, plus the single real
              shadow the system allows for something that floats. */}
          <div className="rounded-panel border border-ink-3 bg-ink-1 p-1.5 shadow-[0_40px_100px_-30px_rgb(0_0_0/0.9),inset_0_1px_0_rgb(255_255_255/0.05)]">
            {/* Below lg the whole editor is 340px of unreadable mush, so the
                frame crops to the canvas instead. Same image, same draggable
                bubble, just the part that carries the argument. The crop is
                done with layout width, not a transform, because the bubble
                measures its bounds and a scaled ancestor would double-count. */}
            <div className="relative aspect-4/3 overflow-hidden rounded-card sm:aspect-3/2 lg:aspect-auto">
              <div className="ml-[-14.8%] mt-[-19.3%] w-[210%] max-w-none lg:m-0 lg:w-full">
                <CameraBubble />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
