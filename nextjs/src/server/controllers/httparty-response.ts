// ERB::Util.url_encode, which HTTParty writes a `query:` hash with: the keys stay in the order given.
export function httpartyQuery(pairs: [string, string][]): string {
  const encode = (value: string) =>
    [...Buffer.from(value, "utf8")]
      .map((byte) =>
        /[a-zA-Z0-9_.~-]/u.test(String.fromCharCode(byte))
          ? String.fromCharCode(byte)
          : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
      )
      .join("");
  return pairs.map(([key, value]) => `${key}=${encode(value)}`).join("&");
}
