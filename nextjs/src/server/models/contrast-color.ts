// ContrastColor (lib/utilities/contrast_color.rb): readable text colours for a seller's chosen colours.
// Same arithmetic, in the same order, as the Ruby module; golden: __fixtures__/seller-profile-styles.golden.json.
export const WHITE = "#ffffff";
export const BLACK = "#000000";
export const WCAG_AA_NORMAL_TEXT = 4.5;
const APCA_TIE_BAND = 10.0;


type Rgb = number[];

// ContrastColor.parse: [r, g, b], or null when the value is not a hex colour.
export function parse(hexColor: unknown): Rgb | null {
  const value = String(hexColor ?? "").trim() // Ruby strips JavaScript's String#trim set;
  if (/^#[0-9a-f]{6}$/iu.test(value) && !value.includes("\n")) return [value.slice(1, 3), value.slice(3, 5), value.slice(5, 7)].map((c) => parseInt(c, 16));
  if (/^#[0-9a-f]{3}$/iu.test(value)) return value.slice(1).split("").map((c) => parseInt(c + c, 16));
  return null;
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255.0;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(luminance: number, other: number): number {
  return (Math.max(luminance, other) + 0.05) / (Math.min(luminance, other) + 0.05);
}

function apcaScreenLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => (c / 255.0) ** 2.4);
  const y = 0.2126729 * r! + 0.7151522 * g! + 0.072175 * b!;
  return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
}

function apcaLc(text: Rgb, background: Rgb): number {
  const textY = apcaScreenLuminance(text);
  const backgroundY = apcaScreenLuminance(background);
  if (Math.abs(backgroundY - textY) < 0.0005) return 0.0;
  if (backgroundY > textY) {
    const contrast = (backgroundY ** 0.56 - textY ** 0.57) * 1.14;
    return contrast < 0.1 ? 0.0 : (contrast - 0.027) * 100;
  }
  const contrast = (backgroundY ** 0.65 - textY ** 0.62) * 1.14;
  return contrast > -0.1 ? 0.0 : (contrast + 0.027) * 100;
}

// `floor`, as Ruby does.
function shiftBrightness(rgb: Rgb, whiteText: boolean, step: number): Rgb {
  const target = whiteText ? 0 : 255;
  return rgb.map((c) => Math.floor(c + ((target - c) * step) / 255.0));
}

function brightnessShiftFor(rgb: Rgb, whiteText: boolean): number {
  const text = parse(whiteText ? WHITE : BLACK)!;
  if (contrastRatio(relativeLuminance(rgb), relativeLuminance(text)) >= WCAG_AA_NORMAL_TEXT) return 0;
  let low = 0;
  let high = 255;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const shifted = shiftBrightness(rgb, whiteText, middle);
    if (contrastRatio(relativeLuminance(shifted), relativeLuminance(text)) >= WCAG_AA_NORMAL_TEXT) high = middle;
    else low = middle + 1;
  }
  return low;
}

// ContrastColor.for
export function contrastFor(hexColor: unknown): string {
  const rgb = parse(hexColor);
  if (rgb === null) return BLACK;
  const luminance = relativeLuminance(rgb);
  const withWhite = contrastRatio(luminance, relativeLuminance(parse(WHITE)!));
  const withBlack = contrastRatio(luminance, relativeLuminance(parse(BLACK)!));
  return withWhite > withBlack ? WHITE : BLACK;
}

// ContrastColor.accessible_accent
export function accessibleAccent(hexColor: unknown): { accent: string; text: string } {
  const rgb = parse(hexColor);
  if (rgb === null) return { accent: BLACK, text: WHITE };
  const white = parse(WHITE)!;
  const black = parse(BLACK)!;
  let whiteText = Math.abs(apcaLc(white, rgb)) > Math.abs(apcaLc(black, rgb));
  let displayShift = brightnessShiftFor(rgb, whiteText);
  const otherShift = brightnessShiftFor(rgb, !whiteText);
  if (otherShift < displayShift && Math.abs(Math.abs(apcaLc(white, rgb)) - Math.abs(apcaLc(black, rgb))) <= APCA_TIE_BAND) {
    whiteText = !whiteText;
    displayShift = otherShift;
  }
  return { accent: toHex(shiftBrightness(rgb, whiteText, displayShift)), text: whiteText ? WHITE : BLACK };
}

// ContrastColor.ratio_between
export function ratioBetween(hexColor: unknown, otherHexColor: unknown): number | null {
  const a = parse(hexColor);
  const b = parse(otherHexColor);
  if (a === null || b === null) return null;
  return contrastRatio(relativeLuminance(a), relativeLuminance(b));
}
