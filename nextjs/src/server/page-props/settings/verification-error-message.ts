// UserComplianceInfoRequest#verification_error_message (app/models/user_compliance_info_request.rb) for the
// payments page. An address-mismatch code reads the seller's address history first: a P.O. Box in it replaces
// whatever Stripe said, even a message of its own.
import { poBoxInAddressHistory } from "../../models/user-compliance-info.ts";
import { NotPortedError } from "../not-ported.ts";

// UserComplianceInfoRequest::PO_BOX_ADDRESS_DEADLOCK_MESSAGE
const PO_BOX_ADDRESS_DEADLOCK_MESSAGE =
  "The address on your document doesn't match the address on your account. Your registered address appears to be a P.O. Box, which our payment partner can't accept on the account itself, so a document showing that P.O. Box will never match and uploading it again won't help. Please contact support and we'll sort out together which address and document will work for you.";

// UserComplianceInfoRequest::ADDRESS_MISMATCH_ERROR_CODES
export const ADDRESS_MISMATCH_ERROR_CODES = ["verification_document_address_mismatch", "verification_failed_address_match"];

const MESSAGES_BY_CODE: Record<string, string> = {
  verification_directors_mismatch:
    "The provided directors on the account could not be verified. Correct any errors on the provided directors or upload a document that matches the provided information.",
  verification_document_address_mismatch:
    "The address on the ID document doesn’t match the address provided on the account. Please verify and correct the provided address on the account, or upload a document with address that matches the account.",
  verification_document_address_missing:
    "The uploaded document is missing the address information. Please upload another document that contains the address information.",
  verification_document_corrupt:
    "The document verification failed as the file was corrupt. Please provide a clearly legible color document (8,000 pixels by 8,000 pixels or smaller), 10 MB or less in size, in JPG or PNG format. Please make sure the file contains all required pages of the document and is not password protected.",
  verification_document_country_not_supported:
    "The provided document is not an acceptable form of ID from a supported country, or is not a type of legal entity document that is expected. Please provide a new file that meets that requirement.",
  verification_document_directors_mismatch:
    "The directors on the document did not match the directors on the account. Upload a document with matching directors or update the directors on the account.",
  verification_document_dob_mismatch:
    "The date of birth on the ID document doesn’t match the date of birth provided on the account. Please verify and correct the provided date of birth on the account, or upload a document with date of birth that matches the account.",
  verification_document_duplicate_type:
    "The same type of document was used twice. Two unique types of documents are required for verification. Upload two different documents.",
  verification_document_expired:
    "The issue or expiry date is missing on the document, or the document is expired. If it’s an identity document, its expiration date must be after the date the document was submitted. If it’s an address document, the issue date must be within the last six months.",
  verification_document_failed_copy:
    "Copies (including photos or scans) of the original document cannot be read. Please upload the original document in color (8,000 pixels by 8,000 pixels or smaller), 10 MB or less in size, in JPG or PNG format. Please make sure the file contains all required pages of the document and is not password protected.",
  verification_document_failed_greyscale:
    "The document verification failed as the file was in gray scale. Please provide a clearly legible color image (8,000 pixels by 8,000 pixels or smaller), 10 MB or less in size, in JPG or PNG format. Please make sure the file contains all required pages of the document and is not password protected.",
  verification_document_failed_other: "There was a problem with verification of the document that you provided.",
  verification_document_fraudulent: "The document might have been altered so it could not be verified.",
  verification_document_id_number_mismatch:
    "The ID number on the ID document doesn’t match the ID number provided on the account. Please verify and correct the provided ID number on the account, or upload a document with ID number that matches the account.",
  verification_document_id_number_missing:
    "The uploaded document is missing the ID number. Please upload another document that contains the ID number.",
  verification_document_incomplete:
    "The document verification failed as it was incomplete. Please provide a clearly legible color image (8,000 pixels by 8,000 pixels or smaller), which is 10 MB or less in size, in JPG or PNG format. Please make sure the file contains all required pages of the document and is not password protected.",
  verification_document_invalid:
    "The provided document is not an acceptable form of ID from a supported country, or is not a type of legal entity document that is expected. Please provide a new file that meets that requirement.",
  verification_document_issue_or_expiry_date_missing:
    "The issue or expiry date is missing on the document, or the document is expired. If it’s an identity document, its expiration date must be after the date the document was submitted. If it’s an address document, the issue date must be within the last six months.",
  verification_document_manipulated: "The document might have been altered so it could not be verified.",
  verification_document_missing_back:
    "The document verification failed as the back side of the document was not provided. Please provide a clearly legible color image (8,000 pixels by 8,000 pixels or smaller), which is 10 MB or less in size, in JPG or PNG format. Please make sure the file contains all required pages of the document and is not password protected.",
  verification_document_missing_front:
    "The document upload failed as the front side of the document was not provided. Please provide a clearly legible color image (8,000 pixels by 8,000 pixels or smaller), which is 10 MB or less in size, in JPG or PNG format. Please make sure the file contains all required pages of the document and is not password protected.",
  verification_document_name_mismatch:
    "The name on the ID document doesn’t match the name provided on the account. Please verify and correct the provided name on the account, or upload a document with name that matches the account.",
  verification_document_name_missing:
    "The uploaded document is missing the name. Please upload another document that contains the name.",
  verification_document_not_readable:
    "The document verification failed as it was not readable. Please provide a valid color image (8,000 pixels by 8,000 pixels or smaller), which is 10 MB or less in size, in JPG or PNG format. Please make sure the file contains all required pages of the document and is not password protected.",
  verification_document_not_signed:
    "The document verification failed as it was not signed. Please provide a clearly legible color image (8,000 pixels by 8,000 pixels or smaller), which is 10 MB or less in size, in JPG or PNG format. Please make sure the file contains all required pages of the document and is not password protected.",
  verification_document_not_uploaded:
    "The document verification failed due to a problem with the file itself. Please provide a clearly legible color image (8,000 pixels by 8,000 pixels or smaller), which is 10 MB or less in size, in JPG or PNG format. Please make sure the file contains all required pages of the document and is not password protected.",
  verification_document_photo_mismatch:
    "The photo on the ID document doesn’t match the photo provided on the account. Please verify and correct the provided photo on the account, or upload a document with photo that matches the account.",
  verification_document_too_large:
    "The document verification failed as the file was too large. Please provide a clearly legible color image (8,000 pixels by 8,000 pixels or smaller), which is 10 MB or less in size, in JPG or PNG format. Please make sure the file contains all required pages of the document and is not password protected.",
  verification_document_type_not_supported:
    "The provided document is not an acceptable form of ID from a supported country, or is not a type of legal entity document that is expected. Please provide a new file that meets that requirement.",
  verification_extraneous_directors:
    "We have identified extra directors that we haven’t been able to verify. Please remove any extraneous directors from the account.",
  verification_failed_address_match:
    "The address on the document doesn’t match the address on the account. Please verify and correct the provided address on the account, or upload a document with address that matches the account.",
  verification_failed_document_match:
    "The information on the account couldn’t be verified. Please either upload a document to confirm the account details, or update the information on your account.",
  verification_failed_id_number_match:
    "The ID number on the document doesn’t match the ID number on the account. Please verify and correct the provided ID number on the account, or upload a document with ID number that matches the account.",
  verification_failed_keyed_identity:
    "The identity information you entered cannot be verified. Please correct any errors or upload a document that matches the identity fields (e.g., name and date of birth) that you entered.",
  verification_failed_keyed_match:
    "The information on the account couldn’t be verified. Please either upload a document to confirm the account details, or update the information on your account.",
  verification_failed_name_match:
    "The name on the document doesn’t match the name on the account. Please verify and correct the provided name on the account, or upload a document with name that matches the account.",
  verification_failed_other: "There was a problem with your identity verification.",
  verification_failed_residential_address:
    "We could not verify that the person resides at the provided address. The address must be a valid physical address where the individual resides and cannot be a P.O. Box.",
  verification_failed_tax_id_match:
    "The tax ID that you provided couldn’t be verified with the IRS. Please correct any possible errors in the company name or tax ID, or upload a document that contains those fields.",
  verification_failed_tax_id_not_issued:
    "The tax ID that you provided couldn’t be verified with the IRS. Please correct any possible errors in the company name or tax ID, or upload a document that contains those fields.",
  verification_missing_directors:
    "We have identified directors that haven’t been added on the account. Add any missing directors to the account.",
  verification_missing_executives:
    "We have identified executives that haven’t been added on the account. Add any missing executives to the account.",
  verification_missing_owners:
    "We have identified owners that haven’t been added on the account. Add any missing owners to the account.",
  verification_requires_additional_memorandum_of_associations:
    "We have identified holding companies with significant percentage ownership. Upload a Memorandum of Association for each of the holding companies.",
};

const isHash = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function verificationErrorMessage(verificationError: unknown, userId: bigint): Promise<string | null> {
  // `verification_error.blank?`
  if (verificationError == null || verificationError === false || verificationError === "") return null;
  if (!isHash(verificationError)) throw new NotPortedError("a verification_error that is not a hash");
  if (Object.keys(verificationError).length === 0) return null;
  const { code, message } = verificationError;
  if (
    typeof code === "string" &&
    ADDRESS_MISMATCH_ERROR_CODES.includes(code) &&
    (await poBoxInAddressHistory(userId))
  ) {
    return PO_BOX_ADDRESS_DEADLOCK_MESSAGE;
  }
  if (message !== undefined && message !== null && message !== false) {
    if (typeof message !== "string") throw new NotPortedError("a verification_error message that is not a string");
    return message;
  }
  return typeof code === "string" ? (MESSAGES_BY_CODE[code] ?? null) : null;
}
