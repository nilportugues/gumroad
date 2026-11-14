// The chat completions call of ruby-openai's `OpenAI::Client#chat` as Ai::ProductDetailsGeneratorService makes it: one JSON POST, failing on
// any status outside 2xx. OPENAI_URI_BASE moves it to a stand-in server in tests (ruby-openai's `uri_base`).
import { getConfig } from "../infra/config.ts";

const DEFAULT_URI_BASE = "https://api.openai.com/";
const API_VERSION = "v1";
const SECONDS_TO_MS = 1000;

export class OpenAiChatError extends Error {}

// Resolves to the response text; rejects (as Faraday raises) for a network failure, a timeout and a status outside 2xx.
export async function chatCompletionText(
  parameters: Record<string, unknown>,
  timeoutInSeconds: number,
): Promise<string> {
  const base = String(getConfig("OPENAI_URI_BASE", DEFAULT_URI_BASE)).replace(/\/+$/u, "");
  const response = await fetch(`${base}/${API_VERSION}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${String(getConfig("OPENAI_ACCESS_TOKEN", ""))}`,
    },
    body: JSON.stringify(parameters),
    signal: AbortSignal.timeout(timeoutInSeconds * SECONDS_TO_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new OpenAiChatError(`OpenAI answered ${response.status}`);
  return text;
}
