import Image from "next/image";
import { Icon } from "./icon";

/* The agent is the headline, not the whole product. Everything it can do, a
 * person can do by hand, plus two things that are buttons for people on
 * purpose. Hand edits and agent edits change the same document, so neither
 * one clobbers the other. */

const MORE = [
  { icon: "crop", label: "Crop to 16:9, 9:16, 1:1 or 4:3" },
  { icon: "text-t", label: "Text layers you drag on the video" },
  { icon: "waveform", label: "Denoise, level and fade the audio" },
  { icon: "video-camera", label: "Camera, mic and system audio" },
  { icon: "sparkle", label: "Auto zoom where your cursor settles" },
  { icon: "film-strip", label: "MP4, MOV, WebM, GIF or audio only" },
];

export function ByHand() {
  return (
    <section className="py-20 md:py-28">
      <div className="mx-auto max-w-[1240px] px-5 md:px-10">
        <div className="reveal mx-auto max-w-[760px] text-center">
          <h2 className="text-balance text-[clamp(2.2rem,4.6vw,4rem)]">
            And a whole editor, when you want your hands on it.
          </h2>
          <p className="mx-auto mt-5 max-w-[54ch] text-18 leading-[1.55] text-text-1">
            An agent and a person edit the same document. Drag a clip after the
            agent is done and nothing fights you.
          </p>
        </div>

        <div className="mt-16 grid gap-6 md:grid-cols-2">
          <article className="reveal flex flex-col rounded-[24px] raised p-6 md:p-8">
            <h3 className="text-24">Cut the dead air</h3>
            <p className="mt-2 max-w-[44ch] text-15 leading-[1.6] text-text-1">
              One click finds the silent gaps and removes them, with sound and
              picture kept in sync.
            </p>
            <div className="relative -mx-2 mt-4 h-[300px] overflow-hidden">
              <Image
                src="/shots/v2/trim.png"
                alt="The Trim panel: range start and end, Select and Cut tools, and a Remove dead air button."
                width={619}
                height={880}
                sizes="(max-width: 768px) 88vw, 540px"
                className="block h-auto w-full max-w-[460px]"
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-ink-1 to-transparent" />
            </div>
          </article>

          <article className="reveal flex flex-col rounded-[24px] raised p-6 md:p-8">
            <h3 className="text-24">Re-narrate it cleanly</h3>
            <p className="mt-2 max-w-[44ch] text-15 leading-[1.6] text-text-1">
              Fix the stumbles in the transcript and a studio voice reads it back
              over the same footage, through your own ElevenLabs account.
            </p>
            <div className="-mx-2 mt-4 overflow-hidden">
              <Image
                src="/shots/v2/voice.png"
                alt="The Voiceover panel: connect an ElevenLabs API key. This is the only part of Fetch that uses the internet. Your script is sent to ElevenLabs to be spoken. Your recording, your audio and your filenames are not."
                width={620}
                height={372}
                sizes="(max-width: 768px) 88vw, 540px"
                className="block h-auto w-full max-w-[460px]"
              />
            </div>
            <p className="mt-4 flex items-start gap-2 text-13 leading-[1.55] text-text-2">
              <Icon name="info" className="mt-0.5 size-4" />
              The one feature that uses the internet, and it says so where you
              turn it on. Only the script is sent.
            </p>
          </article>
        </div>

        <ul className="reveal mt-6 grid gap-px overflow-hidden rounded-[24px] bg-ink-3/50 sm:grid-cols-2 lg:grid-cols-3">
          {MORE.map((m) => (
            <li key={m.label} className="flex items-center gap-3 bg-ink-1 px-6 py-5 text-15 text-text-1">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink-2 text-text-0">
                <Icon name={m.icon} className="size-[18px]" />
              </span>
              {m.label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
