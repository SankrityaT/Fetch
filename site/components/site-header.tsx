import Image from "next/image";
import { Icon } from "./icon";

/* One line, 64px, the same height and the same hairline as the app's own
   titlebar. It is a header, not a landmark. */
export function SiteHeader() {
  return (
    <header className="relative z-10 border-b border-ink-3 bg-ink-1/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-6 px-6 md:px-10">
        <a
          href="/"
          className="flex items-center gap-2.5 rounded-inset"
          aria-label="Fetch, home"
        >
          <Image
            src="/fetch-icon-1024.png"
            alt=""
            width={64}
            height={64}
            className="size-7 rounded-[7px]"
          />
          <span className="font-display text-18 font-extrabold tracking-[-0.03em]">
            Fetch
          </span>
        </a>

        <nav className="ml-auto flex items-center gap-1">
          <a
            href="#how"
            className="hidden rounded-pill px-3 py-2 text-13 font-semibold text-text-1 transition-colors duration-[120ms] ease-entrance hover:bg-ink-2 hover:text-text-0 sm:block"
          >
            How it works
          </a>
          <a
            href="#privacy"
            className="hidden rounded-pill px-3 py-2 text-13 font-semibold text-text-1 transition-colors duration-[120ms] ease-entrance hover:bg-ink-2 hover:text-text-0 sm:block"
          >
            Privacy
          </a>
          <a
            href="#download"
            className="ml-2 inline-flex h-9 items-center gap-1.5 rounded-pill border border-ink-3 bg-ink-2 px-4 text-13 font-semibold text-text-0 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] transition-[background-color,border-color,transform] duration-[120ms] ease-entrance hover:border-ink-4 hover:bg-ink-3 active:translate-y-px"
          >
            <Icon name="download-simple" className="size-4 text-text-1" />
            Download
          </a>
        </nav>
      </div>
    </header>
  );
}
