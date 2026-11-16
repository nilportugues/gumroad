// ApplicationController#is_bot? and BOT_MAP (config/initializers/bots.rb): the user agents Gumroad treats as crawlers.
import agents from "./bot-user-agents.generated.json" with { type: "json" };

const KNOWN_AGENTS = new Set<string>(agents);
const BOT_SUBSTRINGS = ["msnbot", "yahoo! slurp", "googlebot", "whatsapp"];

export function isBot(userAgent: string | null, userAgentBotParam: unknown): boolean {
  if (userAgent === null) return false;
  const present = typeof userAgentBotParam === "string" ? userAgentBotParam.trim() !== "" : userAgentBotParam !== undefined && userAgentBotParam !== null;
  return KNOWN_AGENTS.has(userAgent) || BOT_SUBSTRINGS.some((bot) => userAgent.toLowerCase().includes(bot)) || present;
}
