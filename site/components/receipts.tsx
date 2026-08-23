import Image from "next/image";

/* The hero claims your recording stays on your machine. Marketing pages assert
 * that constantly and it is usually worth nothing, so this section does not
 * assert it again. It shows the working.
 *
 * Every line here was checked against the shipping code before it was written,
 * and it has already gone stale once, so re-run these before a release rather
 * than trusting this comment:
 *
 *   - grep every http(s) URL across main.js, processor.js and ui/*.js. One
 *     literal, the update manifest. The metrics endpoint is an env var rather
 *     than a literal, so a URL grep alone will not find it. Check
 *     ui/telemetry.js as well.
 *   - grep fetch / XMLHttpRequest / net.request / axios / WebSocket. Two call
 *     sites now: https.get in ui/updater.js, https.request in ui/telemetry.js
 *   - there is no auth code. The only `session` hits are Electron's display
 *     media permission API
 *   - saveDir defaults to null, which main.js resolves to the Desktop
 *
 * The telemetry module landed after this section was first written and made the
 * "one thing it contacts" claim false. Rather than soften the section, it now
 * states the payload exactly. A specific claim someone can verify is stronger
 * than a vague one they cannot, and it survives being grepped.
 *
 * Layout is a hairline-separated claim/receipt list. Deliberately not cards and
 * deliberately not centred: the hero is an asymmetric split and the editor
 * section is a centred stack, so this is a third family.
 */

const RECEIPTS = [
  {
    claim: "No account",
    body: "There is no backend, so there is nothing to sign in to. Fetch has never had a server, which is a stronger promise than a privacy policy is.",
  },
  {
    claim: "Two things it contacts",
    body: "It asks GitHub whether a newer version exists, and once a day it says that one more copy of Fetch exists. That second one sends a random id, the app version and your macOS version. Never a filename, a recording, a transcript, or anything you typed. There is no account to attach it to.",
    mono: "raw.githubusercontent.com  ·  /api/ping",
  },
  {
    claim: "Both have an off switch",
    body: "Turn off auto-update and it stops asking. Turn off the install count in Settings and Fetch says nothing at all. Build it yourself without a metrics endpoint and that code path does not exist.",
  },
  {
    claim: "Transcription runs on your Mac",
    body: "Parakeet on the Neural Engine, roughly 116x realtime. You do not have to take a landing page's word for it, because the app says so itself:",
    exhibit: true,
  },
  {
    claim: "Recordings are just files",
    body: "They land on your Desktop, or a folder you pick. Delete Fetch tomorrow and they are still sitting there.",
    mono: "~/Desktop",
  },
];

export function Receipts() {
  return (
    <section
      id="privacy"
      className="relative scroll-mt-24 border-t border-ink-3/60 py-24 lg:py-32"
    >
      <div className="mx-auto max-w-[1100px] px-6 md:px-10">
        <h2 className="max-w-[18ch] text-[clamp(2rem,3.6vw,3.25rem)]">
          Nothing leaves your Mac. Here is the{" "}
          <em className="accent pr-[0.06em] leading-[1.1]">receipt</em>.
        </h2>
        <p className="mt-5 max-w-[52ch] text-18 leading-[1.55] text-text-1">
          Loom uploads your recording and gives you a link back. Fetch writes a
          file to your Desktop. Everything below follows from that.
        </p>

        <dl className="mt-14">
          {RECEIPTS.map((r, i) => (
            <div
              key={r.claim}
              className={[
                "grid gap-3 py-8 lg:grid-cols-12 lg:gap-10",
                /* one hairline between rows, none top or bottom */
                i > 0 ? "border-t border-ink-3/60" : "",
              ].join(" ")}
            >
              <dt className="font-display text-24 font-extrabold tracking-[-0.03em] lg:col-span-5">
                {r.claim}
              </dt>
              <dd className="lg:col-span-7">
                <p className="max-w-[58ch] text-15 leading-[1.65] text-text-1">
                  {r.body}
                </p>

                {r.mono ? (
                  <p className="mt-3 font-mono text-13 tracking-[-0.02em] text-text-2">
                    {r.mono}
                  </p>
                ) : null}

                {r.exhibit ? (
                  /* Not a pull quote we typeset. A crop of the running app,
                     lifted straight out of the captions panel capture. The
                     "No transcript yet" half is kept on purpose: it is what
                     proves this is a real UI string and not a line staged for
                     a screenshot. */
                  <figure className="mt-5 max-w-[520px]">
                    <div className="overflow-hidden rounded-card border border-ink-3 bg-ink-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
                      <Image
                        src="/shots/receipt.png"
                        alt='A detail of the Fetch captions panel reading "No transcript yet. Transcribe runs on-device, nothing is uploaded."'
                        width={1200}
                        height={184}
                        sizes="(max-width: 640px) 88vw, 520px"
                        className="block h-auto w-full"
                      />
                    </div>
                    <figcaption className="mt-2 text-12 text-text-2">
                      From the captions panel, unedited.
                    </figcaption>
                  </figure>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
