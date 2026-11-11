// ActionController::Base.helpers.number_to_human_size and InfosHelper#duration_displayable /
// #pagelength_displayable / #resolution_displayable, as ProductFile#file_info reads them.
const UNITS = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB"];
const BASE = 1024;
const SIGNIFICANT_DIGITS = 3;

// number_to_human_size(size): 3 significant digits, trailing zeros stripped, no delimiter.
export function numberToHumanSize(size: number | bigint | null): string | null {
  if (size === null) return null;
  const bytes = Number(size);
  if (bytes < BASE) return `${bytes} ${bytes === 1 ? "Byte" : "Bytes"}`;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(BASE)), UNITS.length - 1);
  const value = bytes / BASE ** exponent;
  const digits = Math.floor(Math.log10(value)) + 1;
  const precision = SIGNIFICANT_DIGITS - digits;
  const factor = 10 ** precision;
  // BigDecimal#round is half up; a decimal literal such as 1.005 is exact there, so round on the shortest string.
  const rounded = Math.round(Number((value * factor).toPrecision(15))) / factor;
  const text = precision > 0 ? rounded.toFixed(precision).replace(/\.?0+$/u, "") : String(rounded);
  return `${text} ${UNITS[exponent]}`;
}

// InfosHelper#duration_displayable
export function durationDisplayable(duration: number | null): string | null {
  if (!duration) return null;
  if (duration < 60) return `0:${String(duration).padStart(2, "0")}`;
  if (duration < 600) {
    const text = `${String(Math.floor(duration / 60)).padStart(2, "0")}:${String(duration % 60).padStart(2, "0")}`;
    return text.startsWith("0") ? text.slice(1) : text;
  }
  return `${Math.floor(duration / 60)} minutes`;
}

// pluralize(count, word)
export const pluralize = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;

// InfosHelper#resolution_displayable
export function resolutionDisplayable(width: number | null, height: number | null): string | null {
  if (width === 1920 && height === 1080) return "1080p";
  if (width === 1280 && height === 720) return "720p";
  if (width === 854 && height === 480) return "480p";
  return width !== null && height !== null ? `${width} x ${height} px` : null;
}
