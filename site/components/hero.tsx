import Image from "next/image";
import { AgentDemo } from "./agent-demo";
import { Icon } from "./icon";

/* The pitch is not "another Mac screen recorder". Recordly is free, open source
 * and shipping daily, and that fight is lost on day one. The pitch is the thing
 * the rest of the agent category structurally cannot do: record a real window on
 * a real Mac, driven by the agent you already pay for, with nothing leaving it.
 *
 * The picture is the name of the product. Your agent threw the ball; Biscuit is
 * on the hill, waiting for it. He is the real app asset placed on top of the
 * painting rather than something the image model drew, because a generated dog
 * is a slightly different dog, and there is only one Biscuit.
 *
 * Text sits left, in the dark part of the sky, so the streak never runs through
 * a word. The run underneath rises over the bottom edge of the scene: the story
 * first, then the proof. */
export function Hero() {
  return (
    <section className="px-3 pt-3 md:px-4 md:pt-4">
      <div className="relative isolate overflow-hidden rounded-[28px] bg-[#120d09] md:h-[min(100svh,960px)] md:min-h-[760px]">
        {/* ── the scene ─────────────────────────────────────────────── */}
        <div aria-hidden="true" className="absolute inset-0 -z-10 [container-type:size]">
          <div className="hero-stage">
            <Image
              src="/hero/throw.jpg"
              alt=""
              fill
              preload
              sizes="(max-width: 768px) 200vw, 100vw"
              className="object-cover"
            />
            {/* on a phone the band's top edge would show; melt it into the sky */}
            <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-[#120d09] to-transparent md:hidden" />
            {/* Feet on the grass just short of where the ball comes down:
                x 64%, hill surface at about 81% of the image height there. */}
            <div className="absolute left-[63.5%] bottom-[18.2%] w-[5.2%]">
              <div className="motion-safe:animate-[wait_2.6s_ease-in-out_infinite]">
                <Image
                  src="/mascot/sit-happy.png"
                  alt=""
                  width={240}
                  height={240}
                  className="h-auto w-full drop-shadow-[0_6px_10px_rgb(0_0_0/0.55)]"
                />
              </div>
            </div>
          </div>

          {/* Legibility, not decoration: the sky is dark already, these only
              make sure it stays dark behind the words at every crop. */}
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgb(12_9_7/0.78)_0%,rgb(12_9_7/0.45)_38%,transparent_62%)] md:bg-[linear-gradient(90deg,rgb(12_9_7/0.6)_0%,rgb(12_9_7/0.25)_40%,transparent_60%)]" />
          <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-[rgb(12_9_7/0.55)] to-transparent" />
        </div>
        <div aria-hidden="true" className="grain pointer-events-none absolute inset-0 -z-10" />

        {/* ── the words ─────────────────────────────────────────────── */}
        <div className="relative mx-auto flex h-full max-w-[1240px] flex-col justify-center px-5 pb-[380px] pt-28 md:px-10 md:pb-44">
          <div className="max-w-[640px]">
            <p
              className="rise flex w-fit items-center gap-2 rounded-pill bg-white/[0.07] py-1.5 pl-1.5 pr-3.5 text-13 font-semibold text-text-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] backdrop-blur-md"
              style={{ ["--i" as string]: 0 }}
            >
              <span className="rounded-pill bg-fur-1 px-2 py-0.5 text-12 text-[#231703]">New</span>
              Fetch 2 speaks MCP
            </p>

            <h1
              className="rise mt-7 text-balance text-[clamp(2.7rem,5.6vw,5.2rem)] leading-[0.98]"
              style={{ ["--i" as string]: 1 }}
            >
              Let your agent record the{" "}
              <em className="accent pr-[0.06em] font-normal">demo</em>.
            </h1>

            <p
              className="rise mt-7 max-w-[48ch] text-pretty text-18 leading-[1.55] text-text-1"
              style={{ ["--i" as string]: 2 }}
            >
              Fetch is a Mac screen recorder that Claude Code, Codex and Cursor can
              drive. It records any real window, captions it on this Mac and cuts it
              by what was said. No key, no token, no upload.
            </p>

            <div
              className="rise mt-9 flex flex-wrap items-center gap-3"
              style={{ ["--i" as string]: 3 }}
            >
              <a
                href="/download?ref=hero"
                className="inline-flex h-12 items-center gap-2 rounded-pill bg-fur-1 px-6 text-15 font-semibold tracking-[-0.01em] text-[#231703] shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_10px_30px_-10px_rgb(240_169_60/0.6)] transition-[background-color,transform] duration-[120ms] ease-entrance hover:bg-fur-0 active:translate-y-px"
              >
                <Icon name="download-simple" className="size-[18px]" />
                Download for Mac
              </a>
              <a
                href="#how"
                className="inline-flex h-12 items-center gap-1.5 rounded-pill bg-white/[0.08] px-5 text-15 font-semibold tracking-[-0.01em] text-text-0 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] backdrop-blur-md transition-[background-color,transform] duration-[120ms] ease-entrance hover:bg-white/[0.14] active:translate-y-px"
              >
                See how it works
                <Icon name="caret-right" className="size-4 text-text-1" />
              </a>
            </div>

            <p className="rise mt-5 text-13 text-text-2" style={{ ["--i" as string]: 3 }}>
              Free and open source. macOS 13 or later.
            </p>
          </div>
        </div>
      </div>

      {/* ── the proof, rising over the edge of the scene ──────────────── */}
      <div
        className="rise relative z-10 mx-auto -mt-6 max-w-[1240px] px-5 md:-mt-32 md:px-10"
        style={{ ["--i" as string]: 4 }}
      >
        <AgentDemo />
      </div>
    </section>
  );
}
