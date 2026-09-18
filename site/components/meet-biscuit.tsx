import { MotionClip } from "./motion-clip";

/* Biscuit is not decoration. He is how the app says what it is doing without
 * a status bar, and he is the consent surface: when an agent drives the Mac,
 * he is in the menu bar for the whole take, so the person always sees the dog.
 * That second job is why this section exists on a page about agents.
 *
 * Each state is the clip the app itself plays for it (landing/DESIGN-HANDOFF.md,
 * the Biscuit table). Copy is about him, never in his voice: he speaks first
 * person only in onboarding. */
const STATES = [
  { clip: "sleeping", title: "Nothing is recording", line: "He naps until there is something to do." },
  { clip: "fetch-away", title: "A take starts", line: "Off he goes the moment recording begins." },
  { clip: "thinking", title: "Working on it", line: "Transcribing and cutting, right on your Mac." },
  { clip: "exporting", title: "Your video is ready", line: "He brings the finished file back to your Desktop." },
] as const;

export function MeetBiscuit() {
  return (
    <section className="py-20 md:py-28">
      <div className="mx-auto max-w-[1240px] px-5 md:px-10">
        <div className="reveal mx-auto max-w-[760px] text-center">
          <h2 className="text-balance text-[clamp(2.2rem,4.6vw,4rem)]">
            Meet <em className="accent pr-[0.06em] font-normal">Biscuit</em>.
          </h2>
          <p className="mx-auto mt-5 max-w-[54ch] text-18 leading-[1.55] text-text-1">
            He is how Fetch tells you what it is doing. And when an agent is
            driving your Mac, he sits in the menu bar for the whole take. You
            always see the dog.
          </p>
        </div>

        <ul className="reveal mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STATES.map((s) => (
            <li key={s.clip} className="flex flex-col overflow-hidden rounded-[24px] raised">
              <div className="relative grid h-[190px] place-items-center overflow-hidden bg-ink-0/40">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-8 bottom-6 h-10 rounded-[50%] bg-fur-1/10 blur-2xl"
                />
                <MotionClip
                  name={s.clip}
                  label={`Biscuit: ${s.title.toLowerCase()}`}
                  className="relative h-[150px] w-auto max-w-full"
                />
              </div>
              <div className="px-6 pb-6 pt-5">
                <h3 className="text-18 tracking-[-0.02em]">{s.title}</h3>
                <p className="mt-1.5 text-15 leading-[1.55] text-text-2">{s.line}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
