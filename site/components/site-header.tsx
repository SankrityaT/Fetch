"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";

/* A floating glass pill rather than a bar welded to the top edge.
 *
 * The logo is assets/mascot/idle.png, the same file the app's own titlebar
 * uses at 26px. Not the .icns export, which bakes a dark rounded plate into
 * the artwork and vanished against a warm near-black bar.
 *
 * There is exactly one Biscuit and this is him. A second, flatter geometric
 * mark used to exist for small sizes and has been deleted: it read as a
 * different dog, which is worse than being slightly noisier at 20px.
 *
 * Biscuit is the app's emotional narrator, so he reacts here too: alert at
 * rest, happy when you touch him. Same mechanic the app uses, not decoration
 * bolted onto a website.
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
              <Image
                src="/mascot/idle.png"
                alt=""
                width={128}
                height={128}
                className="absolute inset-0 size-8 object-contain transition-opacity duration-[200ms] ease-entrance group-hover/logo:opacity-0"
                preload
              />
              <Image
                src="/mascot/happy.png"
                alt=""
                width={128}
                height={128}
                className="absolute inset-0 size-8 object-contain opacity-0 transition-opacity duration-[200ms] ease-entrance group-hover/logo:opacity-100"
              />
            </span>
            <span className="font-display text-18 font-extrabold tracking-[-0.03em] text-text-0">
              Fetch
            </span>
          </a>

          <span className="mx-1 hidden h-5 w-px bg-white/10 sm:block" aria-hidden="true" />

          <nav className="hidden items-center sm:flex">
            {[
              ["The editor", "#editor"],
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
