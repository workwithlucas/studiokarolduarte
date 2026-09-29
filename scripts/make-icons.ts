// Generates the PWA icons: monogram "KD" (serif, cream) on a #B57A88 -> #5A2138 gradient.
// Output is committed: public/icons/*. Run: npx tsx scripts/make-icons.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'

const OUT = 'public/icons'
const FROM = '#B57A88'
const TO = '#5A2138'
const CREAM = '#FBF1EC'
const FONT = "Fraunces, 'Fraunces Variable', Georgia, 'Times New Roman', serif"

/** `scale` is the monogram size relative to the canvas; maskable icons keep it inside the 80% safe zone. */
function svg(size: number, scale: number, radius = 0): string {
  const fontSize = size * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${FROM}"/>
      <stop offset="1" stop-color="${TO}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${radius}" fill="url(#g)"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="${FONT}" font-size="${fontSize}" font-weight="500" letter-spacing="${-fontSize * 0.02}" fill="${CREAM}">KD</text>
</svg>
`
}

async function png(file: string, size: number, scale: number) {
  await sharp(Buffer.from(svg(size, scale))).png().toFile(`${OUT}/${file}`)
}

mkdirSync(OUT, { recursive: true })
await png('icon-192.png', 192, 0.5)
await png('icon-512.png', 512, 0.5)
await png('icon-maskable-512.png', 512, 0.36) // monogram well inside the maskable safe zone
await png('apple-touch-icon.png', 180, 0.5)
writeFileSync(`${OUT}/favicon.svg`, svg(64, 0.5, 14))
console.log('make-icons OK ->', OUT)
