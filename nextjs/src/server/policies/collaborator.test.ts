// Mirrors spec/policies/collaborator_policy_spec.rb and collaborator_invitation_policy_spec.rb for the queries the incomings controller uses.
import type { User } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { collaboratorInvitationPolicy, collaboratorPolicy } from "./collaborator.ts";
import type { SellerContext } from "./seller-context.ts";

const user = (id: bigint) => ({ id }) as User;
const invitee = user(1n);
const inviter = user(2n);
const stranger = user(3n);

// The acting user is the account owner, so the admin role check passes.
const asOwner = (seller: User): SellerContext => ({ user: seller, seller, memberships: [] });

describe("collaboratorPolicy.destroy", () => {
  const collaboration = { seller_id: inviter.id, affiliate_user_id: invitee.id };

  it("lets the seller who added the collaborator end it", () => {
    expect(collaboratorPolicy.destroy(asOwner(inviter), collaboration)).toBe(true);
  });

  it("lets the collaborator end it", () => {
    expect(collaboratorPolicy.destroy(asOwner(invitee), collaboration)).toBe(true);
  });

  it("refuses a seller on neither side", () => {
    expect(collaboratorPolicy.destroy(asOwner(stranger), collaboration)).toBe(false);
  });

  it("refuses a collaboration with no collaborator account to a seller on neither side", () => {
    expect(collaboratorPolicy.destroy(asOwner(stranger), { seller_id: inviter.id, affiliate_user_id: null })).toBe(
      false,
    );
  });
});

describe("collaboratorInvitationPolicy", () => {
  const collaboration = { affiliate_user_id: invitee.id };

  it("lets the invited seller accept and decline", () => {
    expect(collaboratorInvitationPolicy.accept(asOwner(invitee), collaboration)).toBe(true);
    expect(collaboratorInvitationPolicy.decline(asOwner(invitee), collaboration)).toBe(true);
  });

  it("refuses the inviting seller", () => {
    expect(collaboratorInvitationPolicy.accept(asOwner(inviter), collaboration)).toBe(false);
    expect(collaboratorInvitationPolicy.decline(asOwner(inviter), collaboration)).toBe(false);
  });
});
