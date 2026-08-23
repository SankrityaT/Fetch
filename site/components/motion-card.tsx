"use client";

import { useEffect, useState } from "react";

/* Biscuit's motion clips are VP9 WebM with alpha, so they composite straight
 * onto the card with no matte and no box.
 *
 * Two things this has to get right, both documented in landing/DESIGN-HANDOFF.md:
 *
 *   Safari cannot decode VP9 alpha. It falls back to the poster, and the poster
 *   is the clip's real first frame extracted through the libvpx decoder, so it
 *   carries the same transparency and lines up exactly with frame 0. No box, no
 *   jump when it fails.
 *
 *   The clips top out at 480x270. That is a hard ceiling on how large they can
 *   be shown, so the art sits at ~400px inside a lit pool rather than going
 *   full bleed. Scaling them up looks soft and cheap.
 *
 * Under prefers-reduced-motion this renders the poster and never mounts a video
 * at all, rather than mounting one and pausing it.
 */
export function MotionCard({
  clip,
  alt,
}: {
  clip: string;
  alt: string;
}) {
  const [still, setStill] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setStill(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const poster = `/mascot/motion/${clip}-poster.png`;

  return (
    <div className="relative grid place-items-center">
      {/* The art is lit, not floated. One warm source behind the character with
          deep falloff, which is the thing that stops it reading as a sticker
          sitting on a dark rectangle. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute size-[115%] opacity-[0.22] blur-[64px]"
        style={{
          background:
            "radial-gradient(closest-side, var(--color-fur-1) 0%, var(--color-fur-2) 50%, transparent 100%)",
        }}
      />

      {still ? (
        <img
          src={poster}
          alt={alt}
          width={480}
          height={270}
          className="relative block h-auto w-full max-w-[440px]"
        />
      ) : (
        <video
          src={`/mascot/motion/${clip}.webm`}
          poster={poster}
          autoPlay
          loop
          muted
          playsInline
          aria-label={alt}
          className="relative block h-auto w-full max-w-[440px] bg-transparent"
        />
      )}
    </div>
  );
}
