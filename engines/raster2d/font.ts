/**
 * A 3x5 pixel font. Each glyph is five digits, one per row, each digit the
 * 3-bit row pattern (4 = left pixel, 2 = middle, 1 = right). Lowercase maps to
 * uppercase. Advance is 4px (3 + 1 spacing); line height 6px.
 */
import type { Color } from "./color";
import type { Surface } from "./surface";

const GLYPHS: Record<string, string> = {
  "0": "75557", "1": "26227", "2": "71747", "3": "71317", "4": "55711",
  "5": "74717", "6": "74757", "7": "71222", "8": "75757", "9": "75717",
  A: "25755", B: "65656", C: "34443", D: "65556", E: "74647", F: "74644",
  G: "34553", H: "55755", I: "72227", J: "11152", K: "55655", L: "44447",
  M: "57755", N: "65555", O: "25552", P: "65644", Q: "25563", R: "65655",
  S: "34216", T: "72222", U: "55557", V: "55552", W: "55775", X: "55255",
  Y: "55222", Z: "71247",
  " ": "00000", ".": "00002", ",": "00024", ":": "02020", ";": "02024",
  "!": "22202", "?": "61202", "-": "00700", "+": "02720", "$": "36236",
  "/": "11244", "%": "51245", "'": "22000", '"': "55000", "(": "24442",
  ")": "21112", ">": "42124", "<": "12421", "=": "07070", "#": "57575",
  "*": "05250", "_": "00007", "@": "25743", "&": "25253", "^": "25000",
  "[": "64446", "]": "31113",
};

export const FONT_W = 3;
export const FONT_H = 5;
export const FONT_ADVANCE = 4;
export const FONT_LINE = 6;

/** Unicode glyph aliases (×, …) that map onto ASCII glyphs. */
const ALIAS: Record<string, string> = { "×": "*", "…": "." };

function glyph(ch: string): string {
  const u = ALIAS[ch] ?? ch.toUpperCase();
  return GLYPHS[u] ?? GLYPHS["?"];
}

export function textWidth(text: string, scale = 1): number {
  let best = 0;
  for (const line of text.split("\n")) best = Math.max(best, line.length ? line.length * FONT_ADVANCE - 1 : 0);
  return best * scale;
}

export interface TextOptions {
  /** Drop-shadow colour drawn 1px down-right (or outline when outline=true). */
  shadow?: Color;
  outline?: boolean;
  align?: "left" | "center" | "right";
  scale?: number;
  alpha?: number;
}

/** Draw text with its top-left (or top-centre/right when aligned) at (x, y). Returns width in px. */
export function drawText(s: Surface, text: string, x: number, y: number, color: Color, o: TextOptions = {}): number {
  const scale = Math.max(1, Math.floor(o.scale ?? 1));
  const w = textWidth(text, scale);
  let bx = Math.floor(x);
  if (o.align === "center") bx -= Math.floor(w / 2);
  else if (o.align === "right") bx -= w;
  const draw = (ox: number, oy: number, c: Color) => {
    let ly = Math.floor(y) + oy;
    for (const line of text.split("\n")) {
      let cx = bx + ox;
      for (const ch of line) {
        const g = glyph(ch);
        for (let row = 0; row < FONT_H; row++) {
          const bits = g.charCodeAt(row) - 48;
          for (let col = 0; col < FONT_W; col++)
            if (bits & (4 >> col)) s.fillRect(cx + col * scale, ly + row * scale, scale, scale, c, o.alpha ?? 1);
        }
        cx += FONT_ADVANCE * scale;
      }
      ly += FONT_LINE * scale;
    }
  };
  if (o.shadow !== undefined) {
    if (o.outline) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const) draw(dx, dy, o.shadow);
    } else draw(1, 1, o.shadow);
  }
  draw(0, 0, color);
  return w;
}

export function hasGlyph(ch: string): boolean {
  return (ALIAS[ch] ?? ch.toUpperCase()) in GLYPHS;
}
