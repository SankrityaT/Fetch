import Image from "next/image";

/* The one claim the rest of the category structurally cannot make. Every row is
 * from the positioning in landing/DESIGN-HANDOFF.md, and every one of them is
 * about where the pixels come from, which is the only thing that matters here:
 * a web-app demo from Fetch would be indistinguishable from Clueso's. Only
 * shipped products belong in this table. */
const ROWS = [
  { who: "Clueso", records: "A cloud browser. Web apps only, and it wants your staging login.", where: "Their cloud" },
  { who: "HyperFrames", records: "HTML it renders itself. Never a real app.", where: "Their cloud" },
];

const WINDOWS = ["Xcode", "Terminal", "Figma", "VS Code", "Chrome", "Simulator", "Your own app"];

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
              Other agent tools record a browser in the cloud, or a page they drew
              themselves. Fetch records whatever window is on your Mac.
            </p>
          </div>

          <div className="mx-auto mt-12 max-w-[860px] overflow-hidden rounded-panel raised">
            <div className="grid grid-cols-[7.5rem_1fr] gap-x-6 border-b border-white/[0.05] px-6 py-3 font-mono text-11 uppercase tracking-[0.08em] text-text-2 md:grid-cols-[9rem_1fr_7rem]">
              <span>Tool</span>
              <span>What it can record</span>
              <span className="hidden md:block">Runs</span>
            </div>
            {ROWS.map((r) => (
              <div
                key={r.who}
                className="grid grid-cols-[7.5rem_1fr] gap-x-6 border-b border-white/[0.04] px-6 py-4 text-15 md:grid-cols-[9rem_1fr_7rem]"
              >
                <span className="font-semibold text-text-1">{r.who}</span>
                <span className="text-text-2">{r.records}</span>
                <span className="hidden text-text-2 md:block">{r.where}</span>
              </div>
            ))}
            <div className="grid grid-cols-[7.5rem_1fr] gap-x-6 bg-fur-1/[0.07] px-6 py-5 text-15 md:grid-cols-[9rem_1fr_7rem]">
              <span className="flex items-center gap-2 font-semibold text-text-0">
                <Image src="/fetch-icon-1024.png" alt="" width={40} height={40} className="size-5 rounded-[5px]" />
                Fetch
              </span>
              <span className="text-text-0">
                Any real window. Native apps, terminals, editors, browsers.
              </span>
              <span className="hidden font-semibold text-text-0 md:block">Your Mac</span>
            </div>
          </div>

          <ul className="mx-auto mt-10 flex max-w-[760px] flex-wrap justify-center gap-2">
            {WINDOWS.map((w) => (
              <li
                key={w}
                className="rounded-pill bg-ink-1 px-3.5 py-1.5 font-mono text-12 text-text-1 shadow-[inset_0_0_0_1px_var(--color-ink-3)]"
              >
                {w}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-center text-13 text-text-2">
            The Simulator is on that list too. It is just a window.
          </p>
        </div>
      </div>
    </section>
  );
}
