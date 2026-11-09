// The pure half of Ai::ProductDetailsGeneratorService: prompt text, the prompt truncation and the
// parsing of the model's JSON. The OpenAI calls, their timeouts and the retry loop are not ported
// yet (they are recorded by VCR, and no Rails run is available to record them here).

export const PRODUCT_DETAILS_MAX_PROMPT_LENGTH = 500;
export const MAX_NUMBER_OF_CONTENT_PAGES_TO_GENERATE = 6;
export const DEFAULT_NUMBER_OF_CONTENT_PAGES_TO_GENERATE = 4;
// Link::NATIVE_TYPE_DIGITAL, _COURSE, _EBOOK, _MEMBERSHIP, in this order.
export const SUPPORTED_PRODUCT_NATIVE_TYPES = ["digital", "course", "ebook", "membership"] as const;

// Ruby's `%Q{...}.split("\n").map(&:strip).join("\n")`. split keeps interior and leading empty
// lines but drops trailing empty ones, and strip runs per line after the split.
export function rubyHeredocLines(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.trim()).join("\n");
}

// Ruby's String#truncate(length, omission:): counts characters (code points), not UTF-16 units.
export function truncateRuby(text: string, length: number, omission: string): string {
  const characters = Array.from(text);
  if (characters.length <= length) return text;
  return characters.slice(0, length - omission.length).join("") + omission;
}

// Ruby's `blank?` for a string: empty or whitespace only.
export const isBlankText = (text: string | null | undefined): boolean =>
  text === null || text === undefined || /^[\p{White_Space}]*$/u.test(text);

function requireContent(content: string | null | undefined, message: string): string {
  if (content === null || content === undefined || isBlankText(content)) throw new Error(message);
  return content;
}

export type ChatMessage = { role: "system" | "user"; content: string };

export function productDetailsMessages(input: {
  currencyType: string;
  currencyChoices: readonly string[];
  prompt: string;
}): ChatMessage[] {
  const { currencyType, currencyChoices, prompt } = input;
  const system = `
      You are an expert digital product creator. Generate detailed product information based on the user's prompt.

      IMPORTANT: Carefully extract price and currency information from the user's prompt:
      - Look for explicit prices like "for 2 yen", "$10", "€15", "£20", etc.
      - Always use the exact numerical value from the prompt without currency conversion
      - Common currency mappings: "yen" = "jpy", "dollar"/"$" = "usd", "euro"/"€" = "eur", "pound"/"£" = "gbp"
      - Allowed currency codes: ${currencyChoices.join(", ")}
      - If no price is specified, use your best guess based on the product type
      - If no currency is specified, use the seller's default currency: ${currencyType}

      Return the following JSON format **only**:
      {
        "name": "Product name as a string",
        "number_of_content_pages": 2, // Number of chapters or pages to generate based on the user's prompt. If specified more than ${MAX_NUMBER_OF_CONTENT_PAGES_TO_GENERATE} pages/chapters, generate only ${MAX_NUMBER_OF_CONTENT_PAGES_TO_GENERATE} pages/chapters. If no number is specified, generate ${DEFAULT_NUMBER_OF_CONTENT_PAGES_TO_GENERATE} pages/chapters
        "description": "Product description as a safe HTML string with only <p>, <ul>, <ol>, <li>, <h2>, <h3>, <h4>, <strong>, and <em> tags; feel free to add emojis. Don't mention the number of pages or chapters in the description.",
        "summary": "Short summary of the product",
        "native_type": "Must be one of: ${SUPPORTED_PRODUCT_NATIVE_TYPES.join(", ")}",
        "price": 4.99, // Extract the exact price from the prompt if specified, otherwise use your best guess
        "currency_code": "usd", // Extract currency from prompt if specified, otherwise use seller default (${currencyType})
        "price_frequency_in_months": 1 // Only include if native_type is 'membership' (1, 3, 6, 12, 24)
      }
    `;
  return [
    { role: "system", content: rubyHeredocLines(system) },
    { role: "user", content: truncateRuby(prompt, PRODUCT_DETAILS_MAX_PROMPT_LENGTH, "...") },
  ];
}

export function coverImagePrompt(productName: string): string {
  return `Professional, fully covered, high-quality digital product cover image with a modern, clean design and elegant typography. The cover features the product name, '${productName}', centered and fully visible, with proper text wrapping, balanced spacing, and padding. Design is optimized to ensure no text is cropped or cut off. Avoid any clipping or cropping of text, and maintain a margin around all edges. Include subtle gradients, minimalist icons, and a harmonious color palette suited for a digital marketplace. The style is sleek, professional, and visually balanced within a square 1024x1024 canvas.`;
}

export type RichContentProductInfo = {
  name: string;
  description: string;
  native_type: string;
  number_of_content_pages?: number | null;
};

export function richContentPagesMessages(productInfo: RichContentProductInfo): ChatMessage[] {
  const numberOfPages = productInfo.number_of_content_pages ?? DEFAULT_NUMBER_OF_CONTENT_PAGES_TO_GENERATE;
  // The `\n` escapes inside the codeBlock example are real newlines in Ruby's %Q too, so the example
  // is split into lines by rubyHeredocLines exactly as Ruby does.
  const system = `
      You are creating rich content pages for a digital product.
      Generate exactly ${numberOfPages} pages in valid Tiptap JSON format, each page having a title and content array with at least 5-6 meaningful and contextually relevant paragraphs, headings, and lists. Try to match the page titles from the titles of pages/chapters in the description of the product if any.

      CRITICAL: Generate ONLY valid JSON. Always use exactly "type" as the key name, never "type: " or any variation. Ensure all JSON syntax is correct.

      Return a JSON object with pages array. Example output format:
      {
        "pages": [
          { "title": "Page 1",
            "content": [
              { "type": "heading", "attrs": { "level": 2 }, "content": [ { "type": "text", "text": "Heading" } ] },
              { "type": "paragraph", "content": [ { "type": "text", "text": "Paragraph 1" } ] },
              { "type": "orderedList", "content": [ { "type": "listItem", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "List item" } ] } ] } ] },
              { "type": "bulletList", "content": [ { "type": "listItem", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "List item" } ] } ] } ] },
              { "type": "codeBlock", "content": [ { "type": "text", "text": "class Dog\n  def bark\n    puts 'Woof!'\n  end\nend" } ] }
            ]
          }
        ]
      }
    `;
  const user =
    "\n              Create detailed content pages for " +
    `${productInfo.native_type} product:\n` +
    `              Product name: "${productInfo.name}".\n` +
    `              Number of content pages: ${numberOfPages}.\n` +
    `              Product description: "${productInfo.description}".\n` +
    "              ";
  return [
    { role: "system", content: rubyHeredocLines(system) },
    { role: "user", content: user },
  ];
}

// `content.blank?` raises, then the JSON is parsed as returned.
export function parseProductDetailsContent(content: string | null | undefined): unknown {
  return JSON.parse(requireContent(content, "Failed to generate product details - no content returned"));
}

// Repairs keys the model writes as `"type: "` before parsing the rich content pages.
export function parseRichContentPagesContent(content: string | null | undefined): unknown {
  const text = requireContent(content, "Failed to generate rich content pages - no content returned");
  return JSON.parse(text.replace(/"type:[ \t\r\n\f\v]*"/gu, '"type"'));
}
