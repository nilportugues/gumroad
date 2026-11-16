// SellerProfile#custom_styles (app/models/seller_profile.rb + layouts/custom_styles/styles.scss.erb): the
// storefront's compiled stylesheet. The SCSS has no logic beyond `split-color`, so its libsass
// `:compressed` output is written out directly; golden: __fixtures__/seller-profile-styles.golden.json
// (the real model over a matrix of colours, fonts, radii and hover offsets).
// Rails.cache is not consulted: the entry is a pure function of these five columns.
import { accessibleAccent, contrastFor, parse, ratioBetween, WCAG_AA_NORMAL_TEXT } from "./contrast-color.ts";
import { BORDER_RADIUS_CSS, BUTTON_HOVER_OFFSET_CSS, FONT_CHOICES, normalizeHexColor } from "./seller-profile.ts";

export const DANGER_COLOR_CHOICES = ["#dc341e", "#9b1c12", "#ffb4ab"];

export type StyleAttributes = {
  font: string | null;
  highlight_color: string | null;
  background_color: string | null;
  border_radius: string | null;
  button_hover: string | null;
};

// SellerProfile's after_initialize defaults.
export function withDefaults(profile: Partial<StyleAttributes> | null): StyleAttributes {
  return {
    font: profile?.font ?? "ABC Favorit",
    background_color: profile?.background_color ?? "#ffffff",
    highlight_color: profile?.highlight_color ?? "#ff90e8",
    border_radius: profile?.border_radius ?? "small",
    button_hover: profile?.button_hover ?? "lift",
  };
}

// HexColorValidator.safe_for_css?
const CSS_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
const safeForCss = (value: unknown) => typeof value === "string" && CSS_HEX_COLOR.test(value);

// SellerProfile.google_fonts_css_source: Addressable::URI.encode of a fixed shape.
export function googleFontsCssSource(fonts: string[]): string {
  const families = [...fonts].sort().map((font) => `family=${font.replaceAll(" ", "%20")}:wght@400;600`).join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

export const fontFamily = (font: string) => {
  const fallback = font === "Domine" || font === "Merriweather" || font === "Roboto Slab" ? "serif" : font === "Roboto Mono" ? "monospace" : "sans-serif";
  return `"${font}", "ABC Favorit", ${fallback}`;
};

// SellerProfile#danger_color
export function dangerColor(backgroundColor: string): string {
  return DANGER_COLOR_CHOICES.find((color) => (ratioBetween(color, backgroundColor) ?? 0) >= WCAG_AA_NORMAL_TEXT) ?? contrastFor(backgroundColor);
}

// `split-color(#rrggbb)`
const splitColor = (hex: string) => (parse(hex) ?? [0, 0, 0]).join(" ");

export function customStyles(attributes: StyleAttributes): string {
  const { font, highlight_color: highlight, background_color: background, border_radius: radius, button_hover: hover } = attributes;
  if (!safeForCss(highlight) || !safeForCss(background)) return "";
  if (!FONT_CHOICES.includes(font!) || !(radius! in BORDER_RADIUS_CSS) || !(hover! in BUTTON_HOVER_OFFSET_CSS)) return "";

  const accent = accessibleAccent(highlight);
  const textOnBackground = contrastFor(background);
  const textOnPrimary = contrastFor(textOnBackground);
  const danger = dangerColor(background!);
  const family = fontFamily(font!);
  const fontImport = font === "ABC Favorit" ? "" : `@import url(${googleFontsCssSource([font!])});`;

  return (
    `${fontImport}:root{--accent: ${splitColor(highlight!)};--accent-with-text: ${splitColor(accent.accent)};--contrast-accent: ${splitColor(accent.text)};` +
    `--font-family: ${family};--color: ${splitColor(textOnBackground)};--primary: var(--color);--contrast-primary: ${splitColor(textOnPrimary)};` +
    `--filled: ${splitColor(background!)};--contrast-filled: var(--color);--danger: ${splitColor(danger)};--contrast-danger: ${splitColor(contrastFor(danger))};` +
    `--body-bg: ${background};--active-bg: rgb(var(--color) / var(--gray-1));--border-alpha: 1;--radius: ${BORDER_RADIUS_CSS[radius!]};` +
    `--button-hover-offset: ${BUTTON_HOVER_OFFSET_CSS[hover!]}}body{background-color:${background};color:${textOnBackground};font-family:${family}}\n`
  );
}

export { normalizeHexColor };
