import { useState } from 'react';
import { coverThumbUrl } from '@/lib/cover-thumb';

// The cover of a work, small, beside its title — a book standing on a list.
// Portrait (2:3, the shape the cover library's jackets come in), cropped to
// fill, with the faint edge and shadow of a real jacket. Renders nothing at
// all when there is no cover, or when the image cannot be loaded, so the
// row around it falls back to whatever it showed before.

const SIZES = {
  /** A list row: 24×36. */
  row: { width: 24, height: 36 },
  /** A shelf row in the Office: 20×30. */
  shelf: { width: 20, height: 30 },
} as const;

export default function CoverThumb({
  coverUrl,
  size = 'row',
  className = '',
}: {
  coverUrl: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const dims = SIZES[size];
  const src = coverThumbUrl(coverUrl, dims);
  if (!src || failed) return null;
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      width={dims.width}
      height={dims.height}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-[2px] object-cover ring-1 ring-white/15 shadow-[0_1px_3px_rgba(0,0,0,0.6)] ${className}`}
      style={{ width: dims.width, height: dims.height }}
    />
  );
}
