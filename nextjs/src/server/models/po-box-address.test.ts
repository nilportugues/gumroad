import { describe, expect, it } from "vitest";

import { isPoBoxMatch, isPossiblePoBoxMatch } from "./po-box-address.ts";

describe("isPoBoxMatch", () => {
  it.each(["PO Box 65", "P.O. Box 65", "P O BOX 65", "p.o.box65", "Post Office Box 65", "post-office box 9"])(
    "matches %s",
    (address) => expect(isPoBoxMatch(address)).toBe(true),
  );

  it.each([null, undefined, "", "   ", "Box 65, RR 2", "Post Office Boxwood Lane", "12 Mailbox Road"])(
    "does not match %j",
    (address) => expect(isPoBoxMatch(address)).toBe(false),
  );
});

describe("isPossiblePoBoxMatch", () => {
  it.each(["Box 65, RR 2", "Box #65", "Box65", "box.7", "PO Box 65", "Post Office Box 65"])("matches %s", (address) =>
    expect(isPossiblePoBoxMatch(address)).toBe(true),
  );

  it.each([null, "", "Boxwood Lane 4", "12 Mailbox Road", "Box Hill", "1box2", "éBox 5", "Box 5"])(
    "does not match %j",
    (address) => expect(isPossiblePoBoxMatch(address)).toBe(false),
  );
});
