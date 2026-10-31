// Shared ERB pieces our mailers render, reproduced byte for byte (Erubi drops the lines that hold
// only a `<% %>` tag, newline included; `<%= %>` lines keep their indentation and newline).
import { domainConfig } from "../infra/domain.ts";
import { getConfig } from "../infra/config.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { entrypointStylesheetHrefs } from "./stylesheet.ts";

export class MailViewNotPortedError extends Error {}

// ERB::Util.html_escape
export function h(value: string | null | undefined): string {
  return (value ?? "").replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

// CGI.escape, as Hash#to_query applies it to each key and value.
export function cgiEscape(value: string): string {
  return Array.from(Buffer.from(value, "utf8"))
    .map((b) => {
      const ch = String.fromCharCode(b);
      if (/[A-Za-z0-9*\-._]/u.test(ch)) return ch;
      if (ch === " ") return "+";
      return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

// ActionMailer's url helpers with config.action_mailer.default_url_options.
export function mailerUrl(path: string, query: Record<string, string> = {}): string {
  const { protocol, domain } = domainConfig();
  const search = Object.keys(query)
    .sort()
    .map((key) => `${cgiEscape(key)}=${cgiEscape(query[key]!)}`)
    .join("&");
  return `${protocol}://${domain}${path}${search ? `?${search}` : ""}`;
}

// config/initializers/gumroad.rb GumroadAddress.full. ADDRESS_COUNTRY is looked up as alpha3 by
// the countries gem; only the US default is ported.
export function gumroadAddressFull(): string {
  const country = getConfig("ADDRESS_COUNTRY", "US");
  if (country !== "US") throw new MailViewNotPortedError(`ADDRESS_COUNTRY ${country}`);
  const zipPlusFour = `${getConfig("ADDRESS_ZIP", "94104")}-${getConfig("ADDRESS_ZIP_PLUS_FOUR", "5401")}`;
  return `${getConfig("ADDRESS_STREET", "548 Market St")}, ${getConfig("ADDRESS_CITY", "San Francisco")}, ${getConfig("ADDRESS_STATE", "CA")} ${zipPlusFour}, USA`;
}

// layouts/mailers/_header_section.html.erb via MailerHelper#header_section, without a subheading.
export function headerSection(heading: string): string {
  return `<div>\n  <h2>${h(heading)}</h2>\n  \n</div>\n`;
}

// ApplicationHelper#vite_entrypoint_stylesheet_tag("email") in production: stylesheet_link_tag
// over the manifest's CSS files.
function emailStylesheetTags(): string {
  return entrypointStylesheetHrefs("email")
    .map((href) => `<link rel="stylesheet" href="${h(href)}" />`)
    .join("\n");
}

// layouts/email.html.erb for a mailer that sets none of @subject, @installment, @announcement,
// @footer_template or @unsub_link. Outside production the layout adds a non-ASCII environment
// banner, whose path through libxml2 and the encoder is not verified, so it is refused.
export function emailLayout(content: string): string {
  if (railsEnv() !== "production") throw new MailViewNotPortedError(`email layout outside production (${railsEnv()})`);
  const assetHost = domainConfig().assetHost ?? "";
  return `<!-- IMPORTANT: If you modify this file, you may also need to modify app/views/posts/post_email.html.erb -->
<!DOCTYPE html>
<html>
  <head>
    <title></title>
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type">
    <meta name="viewport" content="initial-scale = 1.0, width=device-width">
    ${/* yield :style */ ""}
    ${emailStylesheetTags()}
  </head>
  <body>
    <div class="email ">
      <div class="main">
        ${content}
      </div>
      <div class="footer">
        <div class="paragraphs">
          ${/* render(@footer_template) */ ""}
          <p>${h(gumroadAddressFull())}</p>

        </div>
        <a class="wordmark" href="${h(mailerUrl("/"))}">
          Powered by
          <img src="${h(`${assetHost}/images/email/wordmark_logo.png`)}" alt="Gumroad" style="width: 138px; height: 18px;" width="138" height="18">
        </a>
      </div>
    </div>
  </body>
</html>
`;
}
