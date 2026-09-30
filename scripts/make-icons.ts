// Generates the PWA icons: off-white serif "KD" monogram on black, thin gold ring (tokens.css: --bg, --ink, --gold).
// Output is committed: public/icons/*. Run: npx tsx scripts/make-icons.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'

const OUT = 'public/icons'
const BG = '#0D0D0E'
const INK = '#F3F1EC'
const GOLD = '#C9A96A'
const FONT = "Fraunces, 'Fraunces Variable', Georgia, 'Times New Roman', serif"

/** `scale` is the monogram size relative to the canvas; maskable icons keep it inside the 80% safe zone. */
function svg(size: number, scale: number, radius = 0, ringR = 0.4): string {
  const fontSize = size * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${BG}"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${size * ringR}" fill="none" stroke="${GOLD}" stroke-width="${Math.max(1, size * 0.008)}"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="${FONT}" font-size="${fontSize}" font-weight="500" letter-spacing="${-fontSize * 0.02}" fill="${INK}">KD</text>
</svg>
`
}

async function png(file: string, size: number, scale: number, ringR = 0.4) {
  await sharp(Buffer.from(svg(size, scale, 0, ringR))).png().toFile(`${OUT}/${file}`)
}

mkdirSync(OUT, { recursive: true })
await png('icon-192.png', 192, 0.5)
await png('icon-512.png', 512, 0.5)
await png('icon-maskable-512.png', 512, 0.36, 0.3) // monogram well inside the maskable safe zone
await png('apple-touch-icon.png', 180, 0.5)
writeFileSync(`${OUT}/favicon.svg`, svg(64, 0.5, 14))
console.log('make-icons OK ->', OUT)
