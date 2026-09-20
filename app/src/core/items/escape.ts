// core/items/escape — the missing inverse of decodeXml.
//
// serializeItemXml writes attribute values and <content> RAW, so whatever builds a
// RawItemEntry out of semantic values has to escape them itself. The rules are not the
// same on both sides, and they were measured rather than assumed — over the 1387 <content>
// nodes in files/extracted, Sitecore escapes only & < > there and leaves quotes literal
// (126 nodes contain a bare "), with no numeric character references anywhere. That is
// XmlTextWriter behaviour.
//
// Escaping is ONE LEVEL, matching decodeXml. An Image field stored as `&lt;image … /&gt;`
// decodes to `<image … />` and escapes back to exactly the original; a field whose real
// value contains the literal text `&lt;` was stored as `&amp;lt;` and round-trips too.

/** Escape a value for `<content>`: `& < >` only — quotes stay literal, as Sitecore emits. */
export function escapeContent(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape a value for an attribute: `& < "`, plus the whitespace an XML parser would
 * otherwise normalise away. `>` needs no escaping inside an attribute and Sitecore leaves
 * it alone, so escaping it here would break byte-identity for no gain.
 *
 * In practice only `&` is reachable — Sitecore's item-name validation already rejects
 * the quote and angle-bracket characters. The rest is defence against hand-built models.
 */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#xD;")
    .replace(/\n/g, "&#xA;")
    .replace(/\t/g, "&#x9;");
}
