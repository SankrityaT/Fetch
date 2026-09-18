"use client";

import { useEffect, useRef } from "react";

/* One of Biscuit's motion clips, transparent in every browser.
 *
 * The app ships VP9 WebM with an alpha channel, which Chrome and Firefox
 * composite correctly and Safari plays on a black box. Safari needs HEVC with
 * alpha instead, which Chrome decodes without the alpha and shows on black.
 * So each clip exists twice, and the order of the sources is the whole trick:
 * the QuickTime one first, which only Safari claims it can play, then the WebM
 * everyone else falls through to. The poster is the same frame as a still, for
 * reduced motion and for the moment before the video starts. A person who has
 * asked for reduced motion gets the poster and nothing moves. */
export function MotionClip({
  name,
  label,
  className = "",
}: {
  name: "sleeping" | "thinking" | "fetch-away" | "exporting";
  label: string;
  className?: string;
}) {
  const v = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = v.current;
    if (!el) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      if (mq.matches) {
        el.pause();
        el.removeAttribute("autoplay");
      } else {
        el.play().catch(() => {});
      }
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return (
    <video
      ref={v}
      className={className}
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      poster={`/mascot/motion/${name}-poster.png`}
      aria-label={label}
    >
      <source src={`/mascot/motion/${name}.mov`} type='video/quicktime; codecs="hvc1"' />
      <source src={`/mascot/motion/${name}.webm`} type="video/webm" />
    </video>
  );
}
