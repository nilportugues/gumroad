import { describe, expect, it } from "vitest";

import { fileDetails } from "./file-details.ts";

describe("fileDetails", () => {
  it("names the file without its extension and upcases the extension", () => {
    process.env.SECRET_KEY_BASE = "file-details-test-secret";

    expect(fileDetails({ blob_id: 3n, key: "abc", filename: "My Brief.final.pdf", byte_size: 2048n })).toMatchObject({
      name: "My Brief.final",
      size: 2048,
      extension: "PDF",
      key: "abc",
    });
  });

  it("sanitizes the filename as ActiveStorage::Filename does", () => {
    process.env.SECRET_KEY_BASE = "file-details-test-secret";

    expect(fileDetails({ blob_id: 3n, key: "abc", filename: " a:b/c.PNG ", byte_size: 1 })).toMatchObject({
      name: "a-b-c",
      extension: "PNG",
    });
  });

  it("has an empty extension for a file without one", () => {
    process.env.SECRET_KEY_BASE = "file-details-test-secret";

    expect(fileDetails({ blob_id: 3n, key: "abc", filename: "README", byte_size: 1 })).toMatchObject({
      name: "README",
      extension: "",
    });
  });
});
