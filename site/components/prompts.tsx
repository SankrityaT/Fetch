import Image from "next/image";

/* Say a sentence, get an edit. Each card is a request an agent can carry out
 * over MCP today, the tool calls it takes, and a crop of the real panel it
 * changes. Nothing here is on the roadmap: dead air and voiceover are
 * deliberately absent because they are buttons for a person, not tools for an
 * agent, and they live in the next section instead. */

type Card = {
  tag: string;
  ask: string;
  calls: string;
  src: string;
  w: number;
  h: number;
  alt: string;
};

const WIDE: Card = {
  tag: "Beats",
  ask: "Zoom in where it refuses 1Password",
  calls: "list_beats → apply_edit  ·  Z1 on B2",
  src: "/shots/v2/timeline.png",
  w: 2218,
  h: 360,
  alt: "The Fetch timeline: beats B1 to B4 named from what was said, B2 'An agent asks to record one' highlighted, and zoom Z1 at 1.8x sitting underneath it.",
};

const CARDS: Card[] = [
  {
    tag: "Record",
    ask: "Record my terminal, then caption it",
    calls: "list_windows → record_start",
    src: "/shots/v2/home.png",
    w: 1141,
    h: 905,
    alt: "Fetch's home screen: 'What are we recording today?' above a composer reading 'Record my Chrome window, then caption it', with Claude Code selected.",
  },
  {
    tag: "Captions",
    ask: "Caption it and burn them in",
    calls: "transcribe → apply_edit",
    src: "/shots/v2/captions.png",
    w: 619,
    h: 1253,
    alt: "The Captions panel: transcribed, burn into video on, caption style controls, and the cue list with timestamps.",
  },
  {
    tag: "Look",
    ask: "Frame it on Dusk",
    calls: "get_edit → apply_edit",
    src: "/shots/v2/look.png",
    w: 619,
    h: 1330,
    alt: "The Look panel with the Dusk backdrop selected, output shape Auto, and inset and corner sliders.",
  },
];

function Bubble({ children }: { children: React.ReactNode }) {
  return (
    <p className="relative ml-auto w-fit max-w-full rounded-[18px] rounded-br-[6px] bg-fur-0 px-4 py-2.5 text-15 font-semibold leading-[1.35] text-[#2a1a04]">
      {children}
    </p>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="w-fit rounded-pill bg-ink-2 px-3 py-1 font-mono text-12 text-text-1 shadow-[inset_0_0_0_1px_var(--color-ink-3)]">
      {children}
    </span>
  );
}

export function Prompts() {
  return (
    <section id="how" className="scroll-mt-24 py-20 md:py-28">
      <div className="mx-auto max-w-[1240px] px-5 md:px-10">
        <div className="reveal mx-auto max-w-[800px] text-center">
          <h2 className="text-balance text-[clamp(2.2rem,4.6vw,4rem)]">
            Say it in a sentence. The edit happens.
          </h2>
          <p className="mx-auto mt-5 max-w-[56ch] text-18 leading-[1.55] text-text-1">
            Fetch names everything with a short id, so an agent can point at it:
            C1 is a clip, Z1 a zoom, T1 a text, B1 a beat. The same ids are on
            your timeline, so you always know what it touched.
          </p>
        </div>

        <article className="reveal mt-16 flex flex-col gap-6 rounded-[24px] raised p-5 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <Tag>{WIDE.tag}</Tag>
            <Bubble>{WIDE.ask}</Bubble>
          </div>
          <div className="overflow-hidden rounded-card bg-ink-0 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]">
            <Image
              src={WIDE.src}
              alt={WIDE.alt}
              width={WIDE.w}
              height={WIDE.h}
              sizes="(max-width: 1240px) 94vw, 1180px"
              className="block h-auto w-full"
            />
          </div>
          <p className="font-mono text-13 text-text-2">{WIDE.calls}</p>
        </article>

        <div className="mt-6 grid gap-6 md:grid-cols-3">
          {CARDS.map((c) => (
            <article key={c.tag} className="reveal flex flex-col gap-5 rounded-[24px] raised p-5 md:p-6">
              <Tag>{c.tag}</Tag>
              <Bubble>{c.ask}</Bubble>
              {/* Tall panels are cropped from the top and faded, the way a
                  panel reads in the app: you look at the top and scroll. */}
              <div className="relative h-[360px] overflow-hidden rounded-card bg-ink-0 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]">
                <Image
                  src={c.src}
                  alt={c.alt}
                  width={c.w}
                  height={c.h}
                  sizes="(max-width: 768px) 92vw, 380px"
                  className="block h-auto w-full"
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-ink-1 to-transparent" />
              </div>
              <p className="font-mono text-13 text-text-2">{c.calls}</p>
            </article>
          ))}
        </div>

        <p className="reveal mx-auto mt-10 max-w-[60ch] text-center text-15 text-text-2">
          Then <span className="font-mono text-text-1">export</span>, and a finished
          MP4 is on your Desktop. The agent never opened the editor, and you never
          had to.
        </p>
      </div>
    </section>
  );
}
