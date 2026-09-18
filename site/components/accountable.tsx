import Image from "next/image";

/* An agent that can record your screen is a liability unless you can see what
 * it did and stop what it should never do. Two real surfaces answer that, and
 * the test output underneath is the actual run of test/policy.test.js, because
 * "enforced in code" is only worth saying if the code is right there. */

const POLICY = [
  "ok   human window on a protected app",
  "ok   agent + 1Password refused (ask)",
  "ok   agent + 1Password refused (allowed)",
  "ok   agent + 1Password refused (open)",
  "ok   refusal names the app",
  "ok   allowed mode refuses whole displays",
  "ok   exclusion picks protected windows only",
];

export function Accountable() {
  return (
    <section id="trust" className="scroll-mt-24 py-20 md:py-28">
      <div className="mx-auto max-w-[1240px] px-5 md:px-10">
        {/* ── what it did ───────────────────────────────────────────── */}
        <div className="reveal grid items-end gap-8 lg:grid-cols-[1fr_1fr]">
          <h2 className="text-balance text-[clamp(2.2rem,4.6vw,4rem)]">
            See everything it did.
          </h2>
          <p className="max-w-[46ch] text-18 leading-[1.55] text-text-1 lg:justify-self-end">
            Every recording, transcript, edit and export lands in one log, with the
            agent that did it and how long it took. A row with no logo was you.
          </p>
        </div>

        <div className="reveal mt-12 overflow-hidden rounded-panel bg-ink-1 floating">
          <Image
            src="/shots/v2/activity.png"
            alt="Fetch's Activity log: rows like 'Transcribed a recording, 15 words, 3 cues', 'Changed an edit' and 'Exported a video', each marked with Claude Code or Codex, a duration in milliseconds and a check."
            width={2381}
            height={1451}
            sizes="(max-width: 1240px) 94vw, 1180px"
            className="block h-auto w-full"
          />
        </div>

        {/* ── what it never sees ────────────────────────────────────── */}
        <div className="mt-24 grid items-start gap-12 md:mt-32 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
          <div className="reveal lg:sticky lg:top-28">
            <h2 className="text-balance text-[clamp(2.2rem,4.6vw,4rem)]">
              It can&rsquo;t record what you rule out.
            </h2>
            <p className="mt-5 max-w-[46ch] text-18 leading-[1.55] text-text-1">
              Never records 1Password, Messages, Mail or System Settings. Even when
              an agent records the whole screen, Fetch leaves those windows out of
              the frame, so nothing sensitive reaches the disk.
            </p>
            <p className="mt-4 max-w-[46ch] text-15 leading-[1.65] text-text-2">
              By default every take an agent asks for waits for you. You always see
              one running: the red border, the floating controls, and Biscuit in the
              menu bar.
            </p>

            {/* The rule is in the bridge, not in a tool description. A sentence
                asking a model to be careful is a suggestion. This is a test. */}
            <div className="mt-8 overflow-hidden rounded-card bg-[#141110] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
              <div className="flex items-center justify-between border-b border-white/[0.05] px-4 py-2.5">
                <span className="font-mono text-12 text-text-2">node test/policy.test.js</span>
                <span className="font-mono text-12 text-good">17 passed</span>
              </div>
              <pre className="overflow-x-auto px-4 py-3 font-mono text-12 leading-[1.8] text-text-1">
                {POLICY.map((l) => (
                  <span key={l} className={l.includes("1Password") ? "block text-fur-1" : "block"}>
                    {l}
                  </span>
                ))}
              </pre>
            </div>
            <p className="mt-3 text-13 text-text-2">
              Enforced in code before a take starts, not asked for in a prompt.
            </p>
          </div>

          <div className="reveal overflow-hidden rounded-panel bg-ink-1 floating">
            <Image
              src="/shots/v2/access.png"
              alt="Recording access settings: Ask every time, Allowed apps only, or Anything on screen, and a Never recorded list of 1Password, Bitwarden, Dashlane, LastPass, Proton Pass, Keychain Access, Messages, WhatsApp, Signal, Telegram, Mail, System Settings and System Preferences."
              width={1280}
              height={980}
              sizes="(max-width: 1024px) 92vw, 640px"
              className="block h-auto w-full"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
