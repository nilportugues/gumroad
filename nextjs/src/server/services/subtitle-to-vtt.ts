// Port of app/services/subtitle_to_vtt_service.rb: a seller's SRT (or bare WebVTT) as WebVTT with centered cues, which iOS WebKit
// needs to place captions. Ruby's \s, strip and rstrip are ASCII-only, so the helpers here are too.
const CUE_SETTINGS = "align:center position:50%";
const RUBY_SPACE = "[ \\t\\r\\n\\f\\v]";
const TIMESTAMP = "(?:\\d{1,2}:)?\\d{1,2}:\\d{1,2}[.,]\\d{1,3}";
const TIMING_LINE = new RegExp(`^${RUBY_SPACE}*(${TIMESTAMP})${RUBY_SPACE}*-->${RUBY_SPACE}*(${TIMESTAMP})([^\\n]*)$`, "u");

const rstrip = (value: string) => value.replace(/[\t\n\v\f\r \0]+$/u, "");
const strip = (value: string) => rstrip(value.replace(/^[\t\n\v\f\r ]+/u, ""));

export class InvalidSubtitleEncoding extends Error {}

// Strips the BOM and normalizes line endings. Ruby deletes bytes that are not UTF-8; that case is the caller's to hand back.
export function normalize(raw: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new InvalidSubtitleEncoding("subtitle file is not valid UTF-8");
  }
  return text.replace(/^﻿/u, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function vttTimestamp(timestamp: string): string {
  const [time = "", fraction = ""] = strip(timestamp).split(/[.,]/u);
  const components = time.split(":").map((component) => component.padStart(2, "0"));
  return `${components.join(":")}.${fraction.padEnd(3, "0")}`;
}

function convertCue(block: string, keepNonCueBlocks: boolean): string | null {
  const lines = block.split("\n");
  const timingIndex = lines.findIndex((line) => TIMING_LINE.test(line));
  if (timingIndex === -1) return keepNonCueBlocks ? block : null;

  const match = TIMING_LINE.exec(lines[timingIndex]!)!;
  const textLines = lines.slice(timingIndex + 1);
  if (textLines.every((line) => strip(line) === "")) return null;

  const settings = strip(match[3]!) === "" ? CUE_SETTINGS : strip(match[3]!);
  const timing = `${vttTimestamp(match[1]!)} --> ${vttTimestamp(match[2]!)} ${settings}`;
  const identifierLines = keepNonCueBlocks ? lines.slice(0, timingIndex) : [];
  return [...identifierLines, timing, ...textLines].join("\n");
}

// SubtitleToVttService#perform
export function subtitleToVtt(raw: Uint8Array): string {
  const text = normalize(raw);
  const blocks = text
    .split(/\n{2,}/u)
    .map(rstrip)
    .filter((block) => block !== "");

  if (blocks[0]?.startsWith("WEBVTT")) {
    const header = blocks.shift()!;
    const converted = blocks.flatMap((block) => convertCue(block, true) ?? []);
    return `${[header, ...converted].join("\n\n")}\n`;
  }
  const cues = blocks.flatMap((block) => convertCue(block, false) ?? []);
  return `${["WEBVTT", ...cues].join("\n\n")}\n`;
}
