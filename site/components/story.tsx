import { MotionCard } from "./motion-card";

/* The Affinity card shape: type block on one side, a lit piece of art on the
 * other, cards running horizontally with the next one peeking.
 *
 * The art is animated because Biscuit already is. There are four alpha clips in
 * assets/mascot/motion/ that the app uses for its own state changes, and the
 * site was shipping none of them. Three of them map onto a real product claim,
 * so there are three cards rather than a fourth invented to fill a grid.
 *
 * A horizontal scroll-snap rail, not a three-column card grid. Same reason the
 * editor section is a centred stack and the receipts are a hairline list: four
 * sections, four layout families.
 */

const CARDS = [
  {
    clip: "fetch-away",
    alt: "Biscuit crouched low, about to bolt.",
    title: "Pick a display or a window.",
    body: "System audio, your mic, and a floating camera bubble. The bubble is a separate native window excluded from the capture, so it never lands in the frame it is sitting on top of.",
  },
  {
    clip: "thinking",
    alt: "Biscuit tilting his head, thinking.",
    title: "Captions without the upload.",
    body: "Parakeet runs on your Mac, roughly 116x realtime. The cues come back editable, and you can restyle them and burn them in.",
  },
  {
    clip: "exporting",
    alt: "Biscuit running with a film strip in his mouth.",
    title: "Then it fetches it back.",
    body: "MP4, WebM, GIF or audio only, straight into the folder you picked. No render queue, no link, no waiting on somebody else's server.",
  },
];

export function Story() {
  return (
    <section className="relative scroll-mt-24 overflow-hidden border-t border-ink-3/60 py-24 lg:py-32">
      <div className="mx-auto max-w-[1400px] px-6 md:px-10">
        <h2 className="max-w-[16ch] text-[clamp(2rem,3.6vw,3.25rem)]">
          Record it. Fetch it.{" "}
          <em className="accent pr-[0.06em] leading-[1.1]">Ship</em> it.
        </h2>
      </div>

      {/* Bleeds off the right edge so the next card is visibly cut, which is
          what tells you the rail scrolls without printing the word "scroll". */}
      <div className="mt-12 flex snap-x snap-mandatory gap-5 overflow-x-auto px-6 pb-4 md:px-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {CARDS.map((card) => (
          <article
            key={card.clip}
            className="flex w-[86vw] max-w-[560px] shrink-0 snap-start flex-col overflow-hidden rounded-panel border border-ink-3 bg-ink-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] lg:w-[46vw] lg:max-w-[620px]"
          >
            <div className="p-8 pb-2 lg:p-10 lg:pb-2">
              <h3 className="max-w-[16ch] text-24 lg:text-32">{card.title}</h3>
              <p className="mt-4 max-w-[46ch] text-15 leading-[1.65] text-text-1">
                {card.body}
              </p>
            </div>

            <div className="mt-auto grid min-h-[240px] place-items-center px-6 pb-8 lg:min-h-[280px] lg:px-8">
              <MotionCard clip={card.clip} alt={card.alt} />
            </div>
          </article>
        ))}

        {/* a trailing spacer so the last card can snap clear of the edge */}
        <div aria-hidden="true" className="w-2 shrink-0 md:w-6" />
      </div>
    </section>
  );
}
