/* The app's own Phosphor sprite, 78 symbols, served from our origin.
   Same glyphs, same weights, same optical sizes as the product. */
export function Icon({
  name,
  className = "size-[18px]",
}: {
  name: string;
  className?: string;
}) {
  return (
    <svg className={`shrink-0 fill-current ${className}`} aria-hidden="true">
      <use href={`/sprite.svg#i-${name}`} />
    </svg>
  );
}
