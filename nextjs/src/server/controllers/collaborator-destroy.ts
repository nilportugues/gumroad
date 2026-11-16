// Collaborators::BaseController#destroy and CollaboratorInvitation#decline!, shared by the main and incomings controllers.
import {
  ENDED_BY_AFFILIATE_USER_MAIL,
  ENDED_BY_SELLER_MAIL,
  deliverCollaboratorMail,
  endBlocker,
  loadAliveCollaborator,
  markCollaboratorDeletedBang,
  type CollaboratorEndRow,
} from "../models/collaborator-end.ts";

import { HandBackToRails, RoutingError } from "./application-controller.ts";

// `mark_deleted!` and the products' collab flag, unless a row would fail validation.
export async function endCollaboration(id: number): Promise<CollaboratorEndRow> {
  const row = await loadAliveCollaborator(id);
  if (row === undefined) throw new RoutingError("Not Found");
  const blocker = await endBlocker(row);
  if (blocker !== null) throw new HandBackToRails(blocker);
  await markCollaboratorDeletedBang(row);
  return row;
}

// Either side may end a collaboration; the mail goes to the other one.
export async function destroyCollaboration(currentSellerId: bigint, id: number): Promise<void> {
  const row = await endCollaboration(id);
  if (currentSellerId === BigInt(row.seller_id!)) await deliverCollaboratorMail(ENDED_BY_SELLER_MAIL, row.id);
  else if (currentSellerId === BigInt(row.affiliate_user_id!))
    await deliverCollaboratorMail(ENDED_BY_AFFILIATE_USER_MAIL, row.id);
}
