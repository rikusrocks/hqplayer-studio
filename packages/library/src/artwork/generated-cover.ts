import { createHash } from 'node:crypto';

/**
 * Procedurally generated, license-free abstract album art for the demo fixture library.
 * Deterministic for a given seed, so screenshots and tests are stable. Deliberately text-free:
 * the UI renders titles and format badges itself. `title`/`artist` only add a label for a11y.
 */
export function generateCoverSvg(seed: string, title: string, artist: string): string {
  const label = `${title} — ${artist}`.replace(/[<>&"]/g, '');
  const h = createHash('sha256').update(seed).digest();
  const byte = (i: number) => h[i % h.length] as number;
  const hue1 = Math.round((byte(0) / 255) * 360);
  const hue2 = (hue1 + 40 + Math.round((byte(1) / 255) * 140)) % 360;
  const style = byte(2) % 3;
  const shapes: string[] = [];
  if (style === 0) {
    for (let i = 0; i < 6; i++) {
      const r = 40 + byte(3 + i) * 1.1;
      const cx = 60 + (byte(10 + i) / 255) * 480;
      const cy = 60 + (byte(20 + i) / 255) * 420;
      shapes.push(
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="hsl(${(hue2 + i * 18) % 360} 70% 70%)" opacity="${(0.12 + (byte(30 + i) / 255) * 0.25).toFixed(2)}"/>`,
      );
    }
  } else if (style === 1) {
    for (let i = 0; i < 9; i++) {
      const y = i * 70 - 40;
      shapes.push(
        `<rect x="-60" y="${y}" width="720" height="${18 + (byte(4 + i) % 30)}" fill="hsl(${(hue2 + i * 9) % 360} 65% 65%)" opacity="0.18" transform="rotate(-18 300 300)"/>`,
      );
    }
  } else {
    for (let i = 0; i < 7; i++) {
      const r = 60 + i * 55;
      shapes.push(
        `<circle cx="${450 - (byte(5) % 120)}" cy="${150 + (byte(6) % 120)}" r="${r}" fill="none" stroke="hsl(${(hue2 + i * 12) % 360} 70% 72%)" stroke-width="${2 + (byte(7 + i) % 10)}" opacity="0.35"/>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600" role="img" aria-label="${label}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue1} 55% 22%)"/><stop offset="1" stop-color="hsl(${hue2} 60% 12%)"/></linearGradient></defs>
<rect width="600" height="600" fill="url(#g)"/>
${shapes.join('\n')}
</svg>`;
}
