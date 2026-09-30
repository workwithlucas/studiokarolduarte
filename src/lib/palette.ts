import tokens from '../styles/tokens.css?raw'

/** Professional palette, read from the --prof-N tokens so tokens.css stays the only place colours are written. */
export const PROF_PALETTE: readonly string[] = [...tokens.matchAll(/--prof-\d+:\s*(#[0-9A-Fa-f]{6})\s*;/g)].map((m) => m[1]!)
