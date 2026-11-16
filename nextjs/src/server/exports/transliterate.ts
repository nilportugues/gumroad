// ActiveSupport::Inflector.transliterate(string) and Exports::PurchaseExportService#pseudo_transliterate. I18n maps each non-ASCII
// character of the NFC-normalized string through its approximation table, and "?" for one it does not list. The table below is the
// golden of scripts/golden/purchase-export-transliterate.rb.
import golden from "./__fixtures__/purchase-export-transliterate.golden.json" with { type: "json" };

const APPROXIMATIONS: Readonly<Record<string, string>> = golden.table;
const REPLACEMENT = "?";

export function transliterate(value: string): string {
  return [...value.normalize("NFC")]
    .map((char) => (char < "\u0080" ? char : (APPROXIMATIONS[char] ?? REPLACEMENT)))
    .join("");
}

// A string with a character the table does not list keeps its original spelling, and so does one that already holds a "?".
export function pseudoTransliterate(value: string | null): string | null {
  if (value === null) return null;
  const transliterated = transliterate(value);
  return transliterated.includes(REPLACEMENT) ? value : transliterated;
}
