import type { ProductFile } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/db.ts", () => ({ db: {} }));

const { mediaLocationForDownloadPage } = await import("./download-files.ts");

const epub = (pagelength: number | null) => ({ filetype: "epub", pagelength }) as ProductFile;
const at = (location: number, unit: string | null) => ({ location, unit, timestamp: "2026-01-01T00:00:00Z" });

describe("mediaLocationForDownloadPage for an EPUB", () => {
  it("keeps a percentage as saved", () => {
    expect(mediaLocationForDownloadPage(epub(20), at(50, "percentage"))).toEqual(at(50, "percentage"));
  });

  it("turns a page number into the percentage of the pages, rounded down", () => {
    expect(mediaLocationForDownloadPage(epub(20), at(7, "page_number"))).toEqual(at(35, "percentage"));
    expect(mediaLocationForDownloadPage(epub(21), at(7, "page_number"))).toEqual(at(33, "percentage"));
  });

  it("keeps the float error Ruby's fdiv has, so 29 of 100 pages is 28 percent", () => {
    expect(mediaLocationForDownloadPage(epub(100), at(29, "page_number"))).toEqual(at(28, "percentage"));
  });

  it("never reports 100 percent for a page number", () => {
    expect(mediaLocationForDownloadPage(epub(10), at(10, "page_number"))).toEqual(at(99, "percentage"));
    expect(mediaLocationForDownloadPage(epub(10), at(40, "page_number"))).toEqual(at(99, "percentage"));
  });

  it("reports nothing for a page number of a file without pages", () => {
    expect(mediaLocationForDownloadPage(epub(null), at(3, "page_number"))).toBeNull();
    expect(mediaLocationForDownloadPage(epub(0), at(3, "page_number"))).toBeNull();
  });

  it("reports nothing for a unit an EPUB does not read", () => {
    expect(mediaLocationForDownloadPage(epub(20), at(3, "seconds"))).toBeNull();
  });
});
