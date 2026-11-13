// SellerProfile#validate_json_data (app/models/seller_profile.rb). settings_profile_signed_in_spec.rb records Rails' answer for a tab
// that lists a section twice; every other way the data can break lib/json_schemas/seller_profile.json stays with Rails.
import { describe, expect, it } from "vitest";

import { duplicatedSectionsMessage, jsonDataValid, schemaDuplicates } from "./seller-profile.ts";

describe("schemaDuplicates", () => {
  it("lists no tab for a layout of unique sections", () => {
    expect(
      schemaDuplicates({
        tabs: [
          { name: "Home", sections: [1, 2] },
          { name: "About", sections: [] },
        ],
      }),
    ).toEqual([]);
  });

  it("lists the tabs that repeat a section, counting a bigint and a number as the same id", () => {
    expect(
      schemaDuplicates({
        tabs: [
          { name: "Home", sections: [1, 2] },
          { name: "About", sections: [3, 3n] },
        ],
      }),
    ).toEqual([1]);
  });

  it("reads a JSON string", () => {
    expect(schemaDuplicates('{"tabs":[{"name":"Home","sections":[4,4]}]}')).toEqual([0]);
  });

  it.each([
    ["a missing tabs key", {}],
    ["an extra key", { tabs: [], other: 1 }],
    ["a tab without a string name", { tabs: [{ name: 1, sections: [] }] }],
    ["a tab with an extra key", { tabs: [{ name: "a", sections: [], x: 1 }] }],
    ["sections that are not a list", { tabs: [{ name: "a", sections: "1" }] }],
    ["a section id that is not an integer", { tabs: [{ name: "a", sections: [1.5] }] }],
    ["data that is not a hash", []],
  ])("returns null for %s", (_label, data) => expect(schemaDuplicates(data)).toBeNull());
});

describe("jsonDataValid", () => {
  it("accepts a layout with unique sections and refuses one that repeats a section", () => {
    expect(jsonDataValid({ tabs: [{ name: "Home", sections: [1, 2] }] })).toBe(true);
    expect(jsonDataValid({ tabs: [{ name: "Home", sections: [1, 1] }] })).toBe(false);
    expect(jsonDataValid({ tabs: "x" })).toBe(false);
  });
});

describe("duplicatedSectionsMessage", () => {
  it("names the tab by its position, without the validator's schema suffix", () => {
    expect(duplicatedSectionsMessage(0)).toBe("The property '#/tabs/0/sections' contained duplicated array values");
    expect(duplicatedSectionsMessage(2)).toBe("The property '#/tabs/2/sections' contained duplicated array values");
  });
});
