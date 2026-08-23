import Image from "next/image";

/* Six cards, six real controls, cropped out of captures of the running app.
 *
 * The first version of this rail had Biscuit's motion clips as the art. Wrong
 * call: people evaluating a screen recorder want to see the recorder. The
 * mascot clips are still in public/mascot/motion if a softer section ever wants
 * them.
 *
 * Cropping to a single panel is also what rescued the Look capture problem. The
 * whole-window shots are unreadable at card size, and one of them would never
 * paint its canvas. At panel scale the canvas is irrelevant and every control
 * is legible, so the constraint turned out to be the better composition.
 *
 * Nothing here is drawn by us. If a label reads "Finds silent gaps and removes
 * them for you", that string is in the product.
 *
 * There is no auto zoom card, temporarily. The feature is real, but its panel
 * is labelled "Follow my clicks / pushes in where you clicked" and that is not
 * what happens: main.js registers a cursor-click handler that nothing ever
 * sends, so data.clicks is always empty and zoomMoments always takes its dwell
 * fallback, zooming where the pointer moved a long way and then settled. The
 * app's own label is being corrected on another branch. Any caption written now
 * would either repeat the false claim or contradict the label visible in its
 * own screenshot, so the card comes back once the fix lands and it can be
 * re-shot. public/shots/features/zoom.png is kept for that.
 */

const FEATURES = [
  {
    shot: "range",
    h: 500,
    title: "Trim to a range",
    body: "Set the start and the end from wherever the playhead is, and reset to the full clip when you change your mind.",
    alt: "The range panel, with start and end fields and set to playhead buttons.",
  },
  {
    shot: "cut",
    h: 370,
    title: "Cut out the middle",
    body: "Turn the cut tool on and drag across the timeline. The section goes, and the video and audio stay in sync.",
    alt: "The tool panel, with select and cut modes.",
  },
  {
    shot: "deadair",
    h: 300,
    title: "Remove dead air",
    body: "It finds the silent gaps and takes them out for you, so a rambling take tightens up without you hunting for the pauses.",
    alt: "The clean up panel, with the remove dead air button.",
  },
  {
    shot: "backdrops",
    h: 740,
    title: "Sit it on a backdrop",
    body: "Six gradients, or drop in an image of your own. The recording is inset over the top with rounded corners.",
    alt: "The backdrop panel, showing none, dusk, ember, mint, violet, slate, ink and your image.",
  },
  {
    shot: "shapes",
    h: 350,
    title: "Crop it for anywhere",
    body: "16:9, 1:1, 9:16 or 4:3. The recording is fitted inside whichever shape you pick, so it is ready for the place it is going.",
    alt: "The output shape panel, with auto, 16:9, 1:1, 9:16 and 4:3 options.",
  },
  {
    shot: "transcribe",
    h: 370,
    title: "Transcribe on the machine",
    body: "Parakeet on the Neural Engine, roughly 116x realtime. Keep the cues editable or bake them into the file so they play anywhere.",
    alt: "The transcript panel, with a transcribe button and a burn into video toggle.",
  },
  {
    shot: "captions",
    h: 890,
    title: "Style the captions",
    body: "Font, size, colour, and placement top, middle or bottom. A pill background, or an outline if you turn it off.",
    alt: "The caption style panel, with font, size, colour, placement and pill background controls.",
  },
  {
    shot: "sound",
    h: 790,
    title: "Clean up the audio",
    body: "Denoise the hiss and hum, normalise the loudness so levels stay even, and ride the gain from one slider.",
    alt: "The sound panel, with denoise, normalise loudness and gain controls.",
  },
];

export function Features() {
  return (
    <section className="relative scroll-mt-24 overflow-hidden border-t border-ink-3/60 py-24 lg:py-32">
      <div className="mx-auto max-w-[1400px] px-6 md:px-10">
        <h2 className="max-w-[20ch] text-[clamp(2rem,3.6vw,3.25rem)]">
          Record it. Fetch it.{" "}
          <em className="accent pr-[0.06em] leading-[1.1]">Ship</em> it.
        </h2>
        <p className="mt-5 max-w-[52ch] text-18 leading-[1.55] text-text-1">
          Every panel below is a screenshot of the real thing, not a diagram of
          it.
        </p>
      </div>

      {/* Bleeds off the right edge so the next card is visibly cut, which is
          how you tell the rail scrolls without printing the word "scroll". */}
      <div className="mt-12 flex snap-x snap-mandatory gap-5 overflow-x-auto px-6 pb-4 md:px-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FEATURES.map((f) => (
          <article
            key={f.shot}
            className="flex w-[84vw] max-w-[460px] shrink-0 snap-start flex-col overflow-hidden rounded-panel border border-ink-3 bg-ink-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] sm:w-[62vw] lg:w-[34vw]"
          >
            <div className="p-8 pb-6">
              <h3 className="text-24">{f.title}</h3>
              <p className="mt-3 text-15 leading-[1.65] text-text-1">{f.body}</p>
            </div>

            {/* The crops are different heights because the panels are, so they
                sit on a shared baseline rather than floating centred in a fixed
                box. The cards stay a set, the panels stay honest about size. */}
            <div className="mt-auto flex h-[290px] items-end px-8 pb-8">
              <Image
                src={`/shots/features/${f.shot}.png`}
                alt={f.alt}
                width={1240}
                height={f.h}
                sizes="(max-width: 640px) 76vw, 400px"
                className="max-h-full w-full rounded-inset border border-ink-3/70 object-contain"
              />
            </div>
          </article>
        ))}

        <div aria-hidden="true" className="w-2 shrink-0 md:w-6" />
      </div>
    </section>
  );
}
