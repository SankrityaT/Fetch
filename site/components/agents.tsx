import Image from "next/image";
import { Icon } from "./icon";

/* The vendors' own marks, unmodified, from assets/agents in the app. Claude and
 * Zed are bare glyphs and sit on a Fetch tile; Codex, Cursor and Windsurf ship
 * their own background and become the tile. Same rule the Connect screen uses,
 * so the site and the app show the same five things the same way. */
const AGENTS = [
  { id: "claude", name: "Claude Code", tile: true },
  { id: "codex", name: "Codex", tile: false },
  { id: "cursor", name: "Cursor", tile: false },
  { id: "windsurf", name: "Windsurf", tile: false },
  { id: "zed", name: "Zed", tile: true },
];

export function Agents() {
  return (
    <section id="agents" className="scroll-mt-24 py-20 md:py-28">
      <div className="mx-auto max-w-[1240px] px-5 md:px-10">
        <div className="reveal mx-auto max-w-[760px] text-center">
          <h2 className="text-balance text-[clamp(2.2rem,4.6vw,4rem)]">
            Works with the agent you already pay for.
          </h2>
          <p className="mx-auto mt-5 max-w-[52ch] text-18 leading-[1.55] text-text-1">
            Fetch is an MCP server on your Mac. Whatever you already use can drive
            it, and Fetch never sees a model, a key or a token.
          </p>
        </div>

        <ul className="reveal mx-auto mt-14 flex max-w-[820px] flex-wrap items-start justify-center gap-x-10 gap-y-8">
          {AGENTS.map((a) => (
            <li key={a.id} className="flex w-24 flex-col items-center gap-3">
              <span
                className={[
                  "grid size-[72px] place-items-center overflow-hidden rounded-[18px] floating",
                  a.tile ? "bg-ink-2" : "bg-transparent",
                ].join(" ")}
              >
                <Image
                  src={`/agents/${a.id}.svg`}
                  alt=""
                  width={72}
                  height={72}
                  className={a.tile ? "size-10" : "size-full"}
                />
              </span>
              <span className="text-13 font-semibold text-text-1">{a.name}</span>
            </li>
          ))}
        </ul>

        <div className="reveal mt-12 flex justify-center">
          <p className="flex items-center gap-2.5 rounded-pill bg-ink-1 py-2 pl-2 pr-4 text-13 font-semibold text-text-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_0_0_1px_var(--color-ink-3)]">
            <Image src="/mascot/sit-happy.png" alt="" width={56} height={56} className="size-7" />
            Or ask Biscuit inside Fetch, on your Claude Code or Codex plan
            <Icon name="arrow-right" className="size-4 text-text-2" />
          </p>
        </div>

        {/* The proof that wiring it up is not a support queue: the app writes
            each client's config itself and reads it back. A tick means
            verified, not attempted. */}
        <figure className="reveal mx-auto mt-20 grid max-w-[1040px] items-center gap-10 lg:grid-cols-[1fr_1.35fr]">
          <figcaption className="max-w-[40ch]">
            <p className="font-mono text-12 uppercase tracking-[0.08em] text-text-2">Connect</p>
            <h3 className="mt-3 text-32">No snippet to paste.</h3>
            <p className="mt-4 text-15 leading-[1.65] text-text-1">
              Six clients, four config shapes and two file formats. Fetch writes the
              right one for each and reads it back, so connected means it checked.
              It even raises Codex&rsquo;s tool timeout, which would otherwise cut
              off any recording longer than a minute.
            </p>
          </figcaption>
          <div className="floating overflow-hidden rounded-panel bg-ink-1">
            <Image
              src="/shots/v2/connect.png"
              alt="The Connect step in Fetch's onboarding, showing Claude Code and Codex both connected, with the line: You stay on your own plan. No key, no token, nothing leaves this Mac."
              width={1523}
              height={1153}
              sizes="(max-width: 1024px) 92vw, 600px"
              className="block h-auto w-full"
            />
          </div>
        </figure>
      </div>
    </section>
  );
}
