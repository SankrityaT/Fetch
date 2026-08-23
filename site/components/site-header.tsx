"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";

/* A floating glass pill rather than a bar welded to the top edge.
 *
 * The logo is the app's own vector Biscuit, not the .icns export. The icon
 * ships a dark rounded plate baked into the artwork, which vanished against
 * a warm near-black bar. The mark is gold, drawn from the brand ramp, and
 * built to hold up at 16px.
 *
 * Biscuit is the app's emotional narrator, so he reacts here too: he is alert
 * at rest and happy when you touch him. That is the same mechanic the app
 * uses, not decoration bolted onto a website.
 */
export function SiteHeader() {
  const sentinel = useRef<HTMLDivElement>(null);
  const [floating, setFloating] = useState(false);

  /* IntersectionObserver, not a scroll listener. The bar only needs to know
     one boolean, and a scroll handler would recompute it every frame. */
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setFloating(!entry.isIntersecting),
      { rootMargin: "0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinel} aria-hidden="true" className="absolute top-0 h-px w-full" />

      <header className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
        <div
          className={[
            "glass glass-spec glass-rim pointer-events-auto flex h-14 items-center gap-1 rounded-pill pl-2 pr-2",
            "transition-[transform,box-shadow] duration-[200ms] ease-entrance",
            /* it settles a hair closer to the page once you leave the top,
               which is the only thing the observer is for */
            floating ? "scale-[0.985]" : "",
          ].join(" ")}
        >
          <a
            href="/"
            aria-label="Fetch, home"
            className="group/logo relative flex items-center gap-2 rounded-pill py-1.5 pl-2 pr-3"
          >
            <span className="relative block size-8">
              <svg
                className="absolute inset-0 size-8 transition-opacity duration-[200ms] ease-entrance group-hover/logo:opacity-0"
                aria-hidden="true"
              >
                <use href="/biscuit.svg#biscuit-mark" />
              </svg>
              <svg
                className="absolute inset-0 size-8 opacity-0 transition-opacity duration-[200ms] ease-entrance group-hover/logo:opacity-100"
                aria-hidden="true"
              >
                <use href="/biscuit.svg#biscuit-happy" />
              </svg>
            </span>
            <span className="font-display text-18 font-extrabold tracking-[-0.03em] text-text-0">
              Fetch
            </span>
          </a>

          <span className="mx-1 hidden h-5 w-px bg-white/10 sm:block" aria-hidden="true" />

          <nav className="hidden items-center sm:flex">
            {[
              ["How it works", "#how"],
              ["Privacy", "#privacy"],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="rounded-pill px-3 py-2 text-13 font-semibold text-text-1 transition-colors duration-[120ms] ease-entrance hover:bg-white/8 hover:text-text-0"
              >
                {label}
              </a>
            ))}
          </nav>

          <a
            href="#download"
            className="ml-1 inline-flex h-10 items-center gap-1.5 rounded-pill border border-fur-1 bg-fur-1 px-4 text-13 font-semibold text-[#231703] shadow-[inset_0_1px_0_rgb(255_255_255/0.22)] transition-[background-color,border-color,transform] duration-[120ms] ease-entrance hover:border-fur-0 hover:bg-fur-0 active:translate-y-px"
          >
            <Icon name="download-simple" className="size-4" />
            Download
          </a>
        </div>
      </header>
    </>
  );
}
