# Policies

Pundit policies from `app/policies` ported as plain functions. Five are ported as the pattern:

| Ruby | TypeScript |
| --- | --- |
| `BalancePolicy` | `balance.ts` |
| `DashboardPolicy` | `dashboard.ts` |
| `InstallmentPolicy` | `installment.ts` |
| `Settings::Password::UserPolicy` | `settings/password-user.ts` |
| `Settings::Team::TeamMembershipPolicy` | `settings/team-membership.ts` (takes a record) |

## Using one

```ts
import { getRequestContext } from "@/server/auth/context";
import { authorize } from "@/server/policies/authorize";
import { installmentPolicy } from "@/server/policies/installment";
import { loadSellerContext } from "@/server/policies/seller-context";

const sellerContext = await loadSellerContext(await getRequestContext()); // pundit_user
authorize(installmentPolicy.publish, sellerContext);                      // authorize Installment, :publish?
if (installmentPolicy.sendForPurchase(sellerContext)) { /* policy(Installment).send_for_purchase? */ }
```

`authorize` throws `NotAuthorizedError`. The caller turns it into what
`PunditAuthorization#user_not_authorized` sends: a redirect to the dashboard with the flash
message, or `{ success: false, error }` with 401 for JSON. A `MembershipNotFoundError` is Rails'
`ActiveRecord::RecordNotFound` from `find_user_membership_for_seller!` and becomes a 404.

## Porting another policy

1. Same directory and name as the Ruby file, in kebab case: `app/policies/settings/team/user_policy.rb`
   becomes `settings/team-user.ts`, exporting `settingsTeamUserPolicy`.
2. One function per query, camelCased without the `?`. Aliases (`def new? = create?`) point at the
   same function rather than wrapping it.
3. Call `requireUser(context)` first in every query, unless the Ruby class calls
   `allow_anonymous_user_access!`. That is where Ruby raises for guests.
4. Keep Ruby's evaluation order. `a || b` in Ruby can raise in `a` (a missing membership) before `b`
   runs; the same `||` in TypeScript does the same.
5. Records are Prisma rows. Compare ids (`membership.user_id === user.id`), never objects: ActiveRecord's
   `==` compares class and id.
6. Port the matching `spec/policies/*_spec.rb` into `policies.test.ts` (or a sibling test file) as a
   role matrix, so each role's verdict is checked.

## The context

`SellerContext` is `pundit_user`: `user` is Rails' `logged_in_user`, which is the **impersonated user**
while an admin impersonates. That is `railsLoggedInUser(requestContext)`, not
`requestContext.loggedInUser` (the admin). `loadSellerContext` handles this and loads the user's
switchable team memberships once, as `User#user_memberships_not_deleted_and_ordered` does.
