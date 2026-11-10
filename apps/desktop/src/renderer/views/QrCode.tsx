import { useMemo } from 'react';
import { encode } from 'uqr';

/**
 * QR code drawn as one SVG path (no innerHTML, no network). Always dark-on-white with a quiet
 * zone, whatever the app theme, so phone cameras read it reliably.
 */
export function QrCode({
  text,
  size = 176,
  label,
}: {
  text: string;
  size?: number;
  label: string;
}) {
  const { d, n } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 });
    let path = '';
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d: path, n: qr.size };
  }, [text]);
  return (
    <svg
      className="qr-code"
      width={size}
      height={size}
      viewBox={`0 0 ${n} ${n}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
