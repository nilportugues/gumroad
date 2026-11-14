import { describe, expect, it } from "vitest";

import { addressableEscape, coverAsJson, oembedUrl } from "./asset-preview.ts";

const yaml = (html: string | null, info: string) =>
  `---\n${html === null ? "" : `html: ${JSON.stringify(html)}\n`}info:\n${info}`;
const cover = (oembed: string | null, unsplash: string | null = null) =>
  coverAsJson({ guid: "g", oembed, unsplash_url: unsplash });

describe("coverAsJson for an oEmbed cover", () => {
  const youtube = yaml(
    '<iframe width="356" height="200" src="https://www.youtube.com/embed/qKebcV1jv3A?feature=oembed&showinfo=0" frameborder="0"></iframe>',
    "  height: 200\n  width: 356\n  thumbnail_url: https://i.ytimg.com/vi/qKebcV1jv3A/hqdefault.jpg\n",
  );

  it("reads the player, the thumbnail and the sizes of a YouTube document", () => {
    expect(cover(youtube)).toEqual({
      url: "https://www.youtube.com/embed/qKebcV1jv3A?feature=oembed&showinfo=0&enablejsapi=1",
      original_url: "https://www.youtube.com/embed/qKebcV1jv3A?feature=oembed&showinfo=0&enablejsapi=1",
      thumbnail: "https://i.ytimg.com/vi/qKebcV1jv3A/hqdefault.jpg",
      id: "g",
      type: "oembed",
      filetype: null,
      width: 356,
      height: 200,
      native_width: 356,
      native_height: 200,
    });
  });

  it("scales a wide player down to the display width and truncates the height", () => {
    const vimeo = yaml('<iframe src="//player.vimeo.com/video/76979871"></iframe>', "  width: 1280\n  height: 721\n");

    expect(cover(vimeo)).toMatchObject({
      url: "https://player.vimeo.com/video/76979871?api=1",
      thumbnail: null,
      width: 670,
      height: 377,
    });
  });

  it("reads sizes with String#to_i and leaves the display size unknown for a width that is not positive", () => {
    const odd = yaml("<IFRAME SRC='https://example.com/p'></IFRAME>", '  width: auto\n  height: "300px"\n');

    expect(cover(odd)).toMatchObject({
      url: "https://example.com/p",
      width: null,
      height: null,
      native_width: 0,
      native_height: 300,
    });
  });

  it("has no player URL when the document has no iframe", () => {
    expect(cover(yaml("<p>hi</p>", "  width: 1\n  height: 1\n"))).toMatchObject({ url: null, original_url: null });
  });

  it("drops an unsafe player URL and thumbnail", () => {
    const unsafe = yaml(
      '<iframe src=" JavaScript:alert(1)"></iframe>',
      "  width: 5\n  height: 5\n  thumbnail_url: data:image/png;base64,AA\n",
    );

    expect(cover(unsafe)).toMatchObject({ url: null, thumbnail: null });
  });

  it("keeps an Unsplash photo as the url and the oEmbed thumbnail beside it", () => {
    expect(cover(youtube, "https://images.example.com/a.jpg")).toMatchObject({
      url: "https://images.example.com/a.jpg",
      type: "unsplash",
      thumbnail: "https://i.ytimg.com/vi/qKebcV1jv3A/hqdefault.jpg",
      native_width: 356,
    });
  });

  it("skips a comment, including one that holds another player", () => {
    const json = cover(
      yaml(
        "<div><!-- <iframe src='https://decoy.example.com'></iframe> --><iframe src='https://e.com/real'></iframe></div>",
        "  width: 1\n  height: 1\n",
      ),
    );

    expect(json.url).toBe("https://e.com/real");
  });

  it("decodes the four named references and ASCII numeric ones in the src", () => {
    const json = cover(
      yaml(
        "<iframe src='https://e.com/?a=1&amp;b=2&#38;c=3&#x26;d&quot;&lt;&gt;'></iframe>",
        "  width: 1\n  height: 1\n",
      ),
    );

    expect(json.url).toBe('https://e.com/?a=1&b=2&c=3&d"<>');
  });

  it.each([
    ["an iframe without a src", yaml("<iframe></iframe>", "  width: 1\n  height: 1\n")],
    ["a comment inside a tag", yaml("<iframe <!-- x --> src='https://e.com'></iframe>", "  width: 1\n  height: 1\n")],
    [
      "a comment with a double dash",
      yaml("<!-- a -- b --><iframe src='https://e.com'></iframe>", "  width: 1\n  height: 1\n"),
    ],
    ["an unterminated comment", yaml("<iframe src='https://e.com'></iframe><!-- x", "  width: 1\n  height: 1\n")],
    [
      "a named reference outside the four",
      yaml("<iframe src='https://e.com/?a=1&copy;b'></iframe>", "  width: 1\n  height: 1\n"),
    ],
    [
      "a numeric reference above ASCII",
      yaml("<iframe src='https://e.com/?a=&#233;'></iframe>", "  width: 1\n  height: 1\n"),
    ],
    [
      "a numeric reference without a semicolon",
      yaml("<iframe src='https://e.com/?a=&#38b'></iframe>", "  width: 1\n  height: 1\n"),
    ],
    ["no info hash", "---\nhtml: x\n"],
    ["a document that is not a hash", "--- foo\n"],
    ["a width Ruby cannot call to_i on", yaml("<iframe src='https://e.com'></iframe>", "  width: [1]\n  height: 1\n")],
  ])("hands back %s", (_name, oembed) => {
    expect(() => cover(oembed)).toThrow("is not ported");
  });

  it("hands back a cover with neither a photo nor an oEmbed document", () => {
    expect(() => cover(null)).toThrow("is not ported");
  });
});

describe("addressableEscape", () => {
  it("leaves a plain URL as it is", () => {
    expect(addressableEscape("https://i.vimeocdn.com/video/1-d_295x166?x=1&y=2")).toBe(
      "https://i.vimeocdn.com/video/1-d_295x166?x=1&y=2",
    );
  });

  it.each([
    "https://example.com/a b.png",
    "https://example.com/a%20b",
    "https://example.com/é",
    "https://example.com/a|b",
  ])("hands back %s, which Addressable would re-encode", (url) => {
    expect(() => addressableEscape(url)).toThrow("is not ported");
  });
});

describe("oembedUrl", () => {
  it("adds the YouTube player api flag and answers null without an iframe", () => {
    expect(oembedUrl('<iframe src="https://www.youtube.com/embed/abc?feature=oembed"></iframe>')).toBe(
      "https://www.youtube.com/embed/abc?feature=oembed&enablejsapi=1",
    );
    expect(oembedUrl(null)).toBeNull();
    expect(oembedUrl("<p>no player</p>")).toBeNull();
  });
});
