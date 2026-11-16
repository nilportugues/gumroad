import { describe, expect, it } from "vitest";

import {
  audienceExportCsv,
  audienceExportFilename,
  audienceMemberConditions,
  AudienceExportArgumentError,
  validateAudienceOptions,
} from "./audience-export.ts";

describe("audience export", () => {
  it("names the file after the username and the UTC timestamp", () => {
    expect(audienceExportFilename("gum", new Date("2025-01-02T03:04:05Z"))).toBe("Subscribers-gum_2025-01-02-03-04-05.csv");
  });

  it("raises when no audience type is selected", () => {
    expect(() => validateAudienceOptions({})).toThrow(AudienceExportArgumentError);
    expect(() => validateAudienceOptions({})).toThrow(
      "At least one audience type (followers, customers, or affiliates) must be selected",
    );
    expect(() => validateAudienceOptions({ affiliates: true })).not.toThrow();
  });

  it("joins the selected audience types in followers, customers, affiliates order", () => {
    expect(audienceMemberConditions({ affiliates: true, followers: true })).toEqual(["follower = true", "affiliate = true"]);
    expect(audienceMemberConditions({ customers: true })).toEqual(["customer = true"]);
  });

  it("writes the header and one row per member with Ruby's Time#to_s", () => {
    const csv = audienceExportCsv([
      { email: "follower@example.com", minCreatedAt: new Date("2025-01-01T10:00:00Z") },
      { email: "-risky@example.com", minCreatedAt: null },
    ]);
    expect(csv).toBe(
      "Subscriber Email,Subscribed Time\nfollower@example.com,2025-01-01 10:00:00 UTC\n'-risky@example.com,\n",
    );
  });
});
