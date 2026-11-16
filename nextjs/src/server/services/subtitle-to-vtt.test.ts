import { describe, expect, it } from "vitest";

import { InvalidSubtitleEncoding, subtitleToVtt } from "./subtitle-to-vtt.ts";

const encode = (value: string) => new TextEncoder().encode(value);

// The inputs and outputs are the ones url_redirect_player_pages_spec.rb recorded from SubtitleToVttService.
describe("subtitleToVtt", () => {
  it("converts an SRT with a BOM, CRLF endings, a malformed cue and an empty cue", () => {
    const srt =
      "﻿1\r\n0:00:01,5 --> 0:00:02,000\r\nHello\r\n\r\n2\r\nnot a timing line\r\nlost\r\n\r\n3\r\n00:00:03,000 --> 00:00:04,000\r\nSecond line\r\nover two lines\r\n\r\n4\r\n00:00:05,000 --> 00:00:06,000\r\n   \r\n";
    expect(subtitleToVtt(encode(srt))).toBe(
      "WEBVTT\n\n00:00:01.500 --> 00:00:02.000 align:center position:50%\nHello\n\n00:00:03.000 --> 00:00:04.000 align:center position:50%\nSecond line\nover two lines\n",
    );
  });

  it("keeps the header, notes, identifiers and existing settings of a WebVTT", () => {
    const vtt =
      "WEBVTT\n\nNOTE a note\n\nintro\n00:01.000 --> 00:02.000\nPlain cue\n\n00:03.000 --> 00:04.000 align:start\nPositioned cue\n";
    expect(subtitleToVtt(encode(vtt))).toBe(
      "WEBVTT\n\nNOTE a note\n\nintro\n00:01.000 --> 00:02.000 align:center position:50%\nPlain cue\n\n00:03.000 --> 00:04.000 align:start\nPositioned cue\n",
    );
  });

  it("answers a bare header for an empty file", () => {
    expect(subtitleToVtt(encode(""))).toBe("WEBVTT\n");
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(() => subtitleToVtt(new Uint8Array([0xff, 0xfe, 0x41]))).toThrow(InvalidSubtitleEncoding);
  });
});
