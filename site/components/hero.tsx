import Image from "next/image";
import { AgentDemo } from "./agent-demo";
import { Icon } from "./icon";

/* The pitch is not "another Mac screen recorder". Recordly is free, open source
 * and shipping daily, and that fight is lost on day one. The pitch is the thing
 * the rest of the agent category structurally cannot do: record a real window on
 * a real Mac, driven by the agent you already pay for, with nothing leaving it.
 *
 * So the headline names the job, the subtext names the agents and the
 * exclusions, and the proof underneath is a run rather than a claim. */
export function Hero() {
  return (
    <section className="px-3 pt-3 md:px-4 md:pt-4">
      <div className="dusk grain relative isolate overflow-hidden rounded-[28px] pb-16 pt-32 md:pb-24 md:pt-40">
        <div className="relative z-10 mx-auto max-w-[1240px] px-5 md:px-10">
          <div className="mx-auto max-w-[860px] text-center">
            <p
              className="rise mx-auto flex w-fit items-center gap-2 rounded-pill bg-white/[0.06] py-1.5 pl-1.5 pr-3.5 text-13 font-semibold text-text-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]"
              style={{ ["--i" as string]: 0 }}
            >
              <span className="rounded-pill bg-fur-1 px-2 py-0.5 text-12 text-[#231703]">New</span>
              Fetch 2 speaks MCP
            </p>

            <h1
              className="rise mt-7 text-balance text-[clamp(2.7rem,6.4vw,5.6rem)] leading-[0.98]"
              style={{ ["--i" as string]: 1 }}
            >
              Let your agent record the{" "}
              <em className="accent pr-[0.06em] font-normal">demo</em>.
            </h1>

            <p
              className="rise mx-auto mt-7 max-w-[56ch] text-pretty text-18 leading-[1.55] text-text-1"
              style={{ ["--i" as string]: 2 }}
            >
              Fetch is a Mac screen recorder that Claude Code, Codex and Cursor can
              drive. It records any real window, captions it on this Mac and cuts it
              by what was said. No key, no token, no upload.
            </p>

            <div
              className="rise mt-9 flex flex-wrap items-center justify-center gap-3"
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
                className="inline-flex h-12 items-center gap-1.5 rounded-pill bg-white/[0.07] px-5 text-15 font-semibold tracking-[-0.01em] text-text-0 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] backdrop-blur-md transition-[background-color,transform] duration-[120ms] ease-entrance hover:bg-white/[0.12] active:translate-y-px"
              >
                See how it works
                <Icon name="caret-right" className="size-4 text-text-1" />
              </a>
            </div>

            <p
              className="rise mt-5 flex items-center justify-center gap-2 text-13 text-text-2"
              style={{ ["--i" as string]: 3 }}
            >
              <Image src="/mascot/happy.png" alt="" width={48} height={48} className="size-5" />
              Free and open source. macOS 13 or later.
            </p>
          </div>

          <div className="rise mt-16 md:mt-20" style={{ ["--i" as string]: 4 }}>
            <AgentDemo />
          </div>
        </div>
      </div>
    </section>
  );
}
