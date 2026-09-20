// core/items — item XML  <->  faithful, order-preserving representation.
//
// The per-version `<item>` XML described in wiki/articles/item-serialization.md. The whole
// game here is byte-identity, so this is a small hand-rolled codec (not fast-xml-parser):
//
//  - attributes are kept in document order as RAW (still-escaped) strings,
//  - field <content> is kept RAW (still-escaped),
//
// so serializeItemXml(parseItemXml(x)) === x with no entity/quoting drift. Semantic
// decoding (entities → text, GUID extraction) happens via the helpers, used when the
// package facade projects these entries into the semantic ItemModel (core/model.ts).
//
// Structure is flat and regular:
//   <item A…><fields><field A…><content>…</content></field>…</fields></item>
// Every structural '<'/'>' inside <content> is escaped, so literal "</content>" etc.
// reliably delimit nodes.

/** One `name="rawValue"` attribute; `value` is the exact bytes between the quotes. */
export interface RawAttr {
  name: string;
  value: string;
}

export interface RawField {
  attrs: RawAttr[];
  /** Raw (still-escaped) inner text of `<content>`, or null for a self-closed `<field/>`. */
  content: string | null;
}

/** One item version exactly as stored in a single items/.../xml entry. */
export interface RawItemEntry {
  attrs: RawAttr[];
  fields: RawField[];
}

// ── parse ─────────────────────────────────────────────────────────────────────

interface TagRead {
  name: string;
  attrs: RawAttr[];
  selfClose: boolean;
  end: number; // index just past the closing '>'
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

/** Read a start tag beginning at xml[pos] === '<'. Returns its name, raw attrs, end. */
function readTag(xml: string, pos: number): TagRead {
  if (xml[pos] !== "<") throw new Error("parseItemXml: expected open bracket at " + pos);
  let i = pos + 1;
  const nameStart = i;
  while (i < xml.length && !isSpace(xml[i]) && xml[i] !== "/" && xml[i] !== ">") i++;
  const name = xml.slice(nameStart, i);
  const attrs: RawAttr[] = [];
  while (i < xml.length) {
    while (i < xml.length && isSpace(xml[i])) i++;
    if (xml[i] === "/" && xml[i + 1] === ">") return { name, attrs, selfClose: true, end: i + 2 };
    if (xml[i] === ">") return { name, attrs, selfClose: false, end: i + 1 };
    const aStart = i;
    while (i < xml.length && xml[i] !== "=") i++;
    const aName = xml.slice(aStart, i).trim();
    i++; // skip '='
    const quote = xml[i];
    if (quote !== '"' && quote !== "'") {
      throw new Error("parseItemXml: unquoted attribute value for " + aName);
    }
    i++; // skip opening quote
    const vStart = i;
    while (i < xml.length && xml[i] !== quote) i++;
    attrs.push({ name: aName, value: xml.slice(vStart, i) });
    i++; // skip closing quote
  }
  throw new Error("parseItemXml: unterminated tag");
}

/** Parse one item-version XML entry into its faithful raw form. */
export function parseItemXml(xml: string): RawItemEntry {
  const item = readTag(xml, xml.indexOf("<item"));
  if (item.name !== "item") throw new Error("parseItemXml: root is not <item>");
  const fields: RawField[] = [];

  // Locate <fields>…</fields> (or <fields/>).
  const fieldsTag = readTag(xml, xml.indexOf("<fields", item.end));
  if (!fieldsTag.selfClose) {
    let i = fieldsTag.end;
    for (;;) {
      const next = xml.indexOf("<field", i);
      const close = xml.indexOf("</fields>", i);
      if (next === -1 || (close !== -1 && close < next)) break;
      const f = readTag(xml, next);
      if (f.selfClose) {
        fields.push({ attrs: f.attrs, content: null });
        i = f.end;
        continue;
      }
      // expect <content>…</content>
      const cOpen = xml.indexOf("<content", f.end);
      const cTag = readTag(xml, cOpen);
      let content: string;
      if (cTag.selfClose) {
        content = "";
      } else {
        const cEnd = xml.indexOf("</content>", cTag.end);
        content = xml.slice(cTag.end, cEnd);
      }
      fields.push({ attrs: f.attrs, content });
      i = xml.indexOf("</field>", cOpen);
      i = i === -1 ? xml.length : i + "</field>".length;
    }
  }
  return { attrs: item.attrs, fields };
}

// ── serialize (byte-identical inverse of parseItemXml) ──────────────────────────

// NOTE: strings are built with concatenation, not template literals — the oxc transform
// used by the test runner mis-lexes a literal '"' or '<' inside a `template`.
function attrsToString(attrs: RawAttr[]): string {
  return attrs.map((a) => " " + a.name + '="' + a.value + '"').join("");
}

export function serializeItemXml(entry: RawItemEntry): string {
  let out = "<item" + attrsToString(entry.attrs) + "><fields>";
  for (const f of entry.fields) {
    if (f.content === null) {
      out += "<field" + attrsToString(f.attrs) + " />";
    } else {
      out +=
        "<field" + attrsToString(f.attrs) + "><content>" + f.content + "</content></field>";
    }
  }
  out += "</fields></item>";
  return out;
}

// ── semantic helpers (used by the package facade) ───────────────────────────────

/**
 * Decode XML text entities (`&lt; &gt; &amp; &quot; &apos;` and numeric refs) one level.
 *
 * `&amp;` must be replaced LAST, or `&amp;lt;` would collapse two levels to `<`. Numeric
 * refs are decoded because escapeAttr emits them for CR/LF/TAB — without this the codec
 * would not read back its own output.
 */
export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

/** Get a decoded attribute value by name from a raw attr list. */
export function getAttr(attrs: RawAttr[], name: string): string | undefined {
  const a = attrs.find((x) => x.name === name);
  return a ? decodeXml(a.value) : undefined;
}
