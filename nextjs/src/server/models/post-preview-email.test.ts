import { describe, expect, it, vi } from "vitest";

import { PostEmailNotPortedError } from "../mail/post-email-template.ts";

import type { InstallmentPost } from "./installment-post.ts";
import { sendPostPreview } from "./installment-send.ts";
import { type PostEmailDeps, ResendApiResponseError, SendGridApiResponseError } from "./post-email-api.ts";
import { PreviewEmailError } from "./save-installment.ts";
import { NotPortedError } from "./user.ts";
import { previewThroughPostEmailApi } from "./workflow-save-installments.ts";

const processPostEmail = vi.hoisted(() => vi.fn());
vi.mock("./post-email-api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./post-email-api.ts")>()),
  processPostEmail,
}));

const post = (hasFiles: boolean) => ({ hasFiles: () => Promise.resolve(hasFiles) }) as unknown as InstallmentPost;
const deps = {} as PostEmailDeps;

describe("sendPostPreview", () => {
  it("hands PostEmailApi one recipient with no records and the preview flag", async () => {
    processPostEmail.mockReset().mockResolvedValue(undefined);
    const subject = post(false);

    await sendPostPreview(subject, "seller@example.com", deps);

    expect(processPostEmail).toHaveBeenCalledWith(
      { post: subject, recipients: [{ email: "seller@example.com" }], preview: true },
      deps,
    );
  });

  it("refuses a post with files before sending, since the preview needs a UrlRedirect", async () => {
    processPostEmail.mockReset();

    await expect(sendPostPreview(post(true), "seller@example.com", deps)).rejects.toBeInstanceOf(
      PostEmailNotPortedError,
    );
    expect(processPostEmail).not.toHaveBeenCalled();
  });
});

describe("previewThroughPostEmailApi", () => {
  it.each([new ResendApiResponseError("rejected"), new SendGridApiResponseError("rejected")])(
    "turns a $name into the seller's preview error",
    async (failure) => {
      processPostEmail.mockReset().mockRejectedValue(failure);

      await expect(previewThroughPostEmailApi(post(false), "seller@example.com")).rejects.toThrow(
        new PreviewEmailError("Failed to send preview email. Please try again later."),
      );
    },
  );

  it("hands the save back to Rails when the post email template is not ported", async () => {
    processPostEmail.mockReset().mockRejectedValue(new PostEmailNotPortedError("a template"));

    await expect(previewThroughPostEmailApi(post(false), "seller@example.com")).rejects.toBeInstanceOf(NotPortedError);
  });

  it("lets any other failure through", async () => {
    processPostEmail.mockReset().mockRejectedValue(new TypeError("boom"));

    await expect(previewThroughPostEmailApi(post(false), "seller@example.com")).rejects.toThrow("boom");
  });
});
