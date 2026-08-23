"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Icon } from "./icon";

/* The hero's one interaction, and the product's one real trick.
 *
 * Fetch records the camera to its own file instead of burning it into the
 * screen pixels, so the bubble can be moved and resized in the editor after
 * the take is over. Rather than assert that in a bullet point, the bubble on
 * this page is the real thing: grab it, move it, drag the corner to resize it.
 *
 * Position and size are held in refs and written straight to style, never to
 * React state. A pointermove that re-renders the tree drops frames on a
 * trackpad and falls apart entirely on touch.
 */

/* The canvas inside the editor screenshot, measured off the image and stored
   as fractions so the bubble tracks the frame at any width. */
const CANVAS = { x: 0.062, y: 0.129, w: 0.624, h: 0.581 };

const MIN_SIZE = 0.1; // fraction of canvas width
const MAX_SIZE = 0.34;

type Vec = { x: number; y: number };

export function CameraBubble() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLDivElement>(null);

  /* Fractions of the canvas box: top-left of the bubble, and its diameter.
     Resting position, lower left, which is where the app puts it. It is still
     draggable for anyone who finds it, but the hero no longer argues from it,
     so it does not get to sit on top of the frame demanding attention. */
  const pos = useRef<Vec>({ x: 0.06, y: 0.6 });
  const size = useRef(0.17);

  const drag = useRef<{
    mode: "move" | "resize";
    pointer: Vec;
    start: Vec;
    startSize: number;
  } | null>(null);

  const [active, setActive] = useState(false);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const bubble = bubbleRef.current;
    if (!canvas || !bubble) return;

    const rect = canvas.getBoundingClientRect();
    const px = size.current * rect.width;

    bubble.style.width = `${px}px`;
    bubble.style.height = `${px}px`;
    bubble.style.transform = `translate3d(${pos.current.x * rect.width}px, ${
      pos.current.y * rect.height
    }px, 0)`;

    if (chipRef.current) {
      /* Geist Mono, tabular, the way every number in the app is set. */
      chipRef.current.textContent = `${Math.round(px)} px`;
    }
  }, []);

  useEffect(() => {
    paint();
    const ro = new ResizeObserver(paint);
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, [paint]);

  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

  const onPointerDown = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      mode,
      pointer: { x: e.clientX, y: e.clientY },
      start: { ...pos.current },
      startSize: size.current,
    };
    setActive(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const canvas = canvasRef.current;
    if (!d || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - d.pointer.x) / rect.width;
    const dy = (e.clientY - d.pointer.y) / rect.height;

    if (d.mode === "move") {
      /* the bubble stays inside the frame, the same way the real one is
         clamped to the canvas it is composited onto */
      const wFrac = size.current;
      const hFrac = (size.current * rect.width) / rect.height;
      pos.current = {
        x: clamp(d.start.x + dx, 0, 1 - wFrac),
        y: clamp(d.start.y + dy, 0, 1 - hFrac),
      };
    } else {
      const next = clamp(d.startSize + dx, MIN_SIZE, MAX_SIZE);
      const hFrac = (next * rect.width) / rect.height;
      size.current = next;
      pos.current = {
        x: clamp(pos.current.x, 0, 1 - next),
        y: clamp(pos.current.y, 0, 1 - hFrac),
      };
    }
    paint();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    drag.current = null;
    setActive(false);
  };

  /* Keyboard parity. The bubble is a real control, so it moves with arrows. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.015;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hFrac = (size.current * rect.width) / rect.height;

    const nudge: Record<string, () => void> = {
      ArrowLeft: () => (pos.current.x = clamp(pos.current.x - step, 0, 1 - size.current)),
      ArrowRight: () => (pos.current.x = clamp(pos.current.x + step, 0, 1 - size.current)),
      ArrowUp: () => (pos.current.y = clamp(pos.current.y - step, 0, 1 - hFrac)),
      ArrowDown: () => (pos.current.y = clamp(pos.current.y + step, 0, 1 - hFrac)),
      "+": () => (size.current = clamp(size.current + 0.02, MIN_SIZE, MAX_SIZE)),
      "=": () => (size.current = clamp(size.current + 0.02, MIN_SIZE, MAX_SIZE)),
      "-": () => (size.current = clamp(size.current - 0.02, MIN_SIZE, MAX_SIZE)),
    };

    if (nudge[e.key]) {
      e.preventDefault();
      nudge[e.key]();
      paint();
    }
  };

  return (
    <div className="relative">
      {/* the real editor, captured from the running app */}
      <Image
        src="/shots/editor.png"
        width={2480}
        height={1600}
        sizes="(max-width: 1024px) 94vw, 62vw"
        alt="The Fetch editor: a clip on the canvas, video and audio lanes on the timeline, and the range inspector open on the right."
        className="block h-auto w-full"
        draggable={false}
        preload
      />

      {/* Traffic lights. The app leaves exactly this gap in its titlebar
          because capturePage does not include the native window frame. */}
      <div
        className="pointer-events-none absolute flex w-[8%] items-center justify-start gap-[6.2%]"
        style={{ left: "1.45%", top: "1.35%", height: "3.25%" }}
        aria-hidden="true"
      >
        {/* 12px lights on a 1240pt window, expressed against this 8% strip so
            they scale with the frame instead of pinning to a device pixel */}
        <span className="aspect-square w-[12.1%] rounded-pill bg-[#FF5F57]" />
        <span className="aspect-square w-[12.1%] rounded-pill bg-[#FEBC2E]" />
        <span className="aspect-square w-[12.1%] rounded-pill bg-[#28C840]" />
      </div>

      {/* the canvas the bubble is allowed to live on */}
      <div
        ref={canvasRef}
        className="absolute"
        style={{
          left: `${CANVAS.x * 100}%`,
          top: `${CANVAS.y * 100}%`,
          width: `${CANVAS.w * 100}%`,
          height: `${CANVAS.h * 100}%`,
        }}
      >
        <div
          ref={bubbleRef}
          role="button"
          tabIndex={0}
          aria-label="Camera bubble. Drag to move it, or use the arrow keys. Plus and minus resize it."
          onPointerDown={onPointerDown("move")}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          className={[
            "group absolute left-0 top-0 touch-none select-none rounded-pill",
            "border border-ink-3 bg-ink-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_10px_30px_-8px_rgb(0_0_0/0.8)]",
            "outline-offset-4 focus-visible:outline-2 focus-visible:outline-fur-1",
            active ? "cursor-grabbing" : "cursor-grab",
          ].join(" ")}
          style={{ willChange: "transform" }}
        >
          <div className="relative size-full overflow-hidden rounded-pill">
            {/* Biscuit stands in for the webcam feed. The real bubble is your
                face; this is the one place the site is illustrative, and it
                is obvious about it. */}
            <Image
              src="/mascot/happy.png"
              alt=""
              width={512}
              height={512}
              sizes="200px"
              className="absolute left-1/2 top-[54%] w-[112%] max-w-none -translate-x-1/2 -translate-y-1/2"
              draggable={false}
            />
          </div>

          {/* ring lifts to gold on hover and while held, the same way selection
              reads everywhere else in the app */}
          <span
            className={[
              "pointer-events-none absolute inset-0 rounded-pill ring-1 transition-[box-shadow,--tw-ring-color]",
              "duration-[120ms] ease-entrance",
              active
                ? "ring-fur-1 shadow-[0_0_0_6px_rgb(240_169_60/0.14)]"
                : "ring-transparent group-hover:ring-fur-1/60",
            ].join(" ")}
          />

          {/* resize handle, bottom-right, the app's own geometry */}
          <span
            onPointerDown={onPointerDown("resize")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className={[
              "absolute -bottom-1 -right-1 grid size-6 cursor-nwse-resize place-items-center",
              "rounded-pill border border-ink-3 bg-ink-2 text-text-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]",
              "transition-opacity duration-[120ms] ease-entrance",
              active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
            ].join(" ")}
          >
            <Icon name="arrows-out-simple" className="size-3" />
          </span>

          {/* live readout, only while you are actually moving it */}
          <div
            ref={chipRef}
            className={[
              "pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap",
              "rounded-pill border border-ink-3 bg-ink-2 px-2 py-1 font-mono text-11 tabular-nums text-text-1",
              "transition-opacity duration-[120ms] ease-entrance",
              active ? "opacity-100" : "opacity-0",
            ].join(" ")}
          />
        </div>
      </div>
    </div>
  );
}
