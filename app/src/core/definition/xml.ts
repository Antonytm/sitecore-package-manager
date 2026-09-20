// core/definition/xml — a minimal, read-only XML tree parser for installer/project.
//
// The definition is machine-generated, well-formed, non-mixed-content XML (elements hold
// EITHER child elements OR text, never both). This parser is just enough to read it; it is
// NOT used on the byte-identity path (that replays the raw entry via zip provenance), so it
// does not need to reproduce formatting.

export interface XmlNode {
  name: string;
  attrs: Array<{ name: string; value: string }>;
  children: XmlNode[];
  /** Text content (entity-decoded) when the node has no element children. */
  text: string;
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseXml(xml: string): XmlNode {
  let i = 0;

  function skipProlog() {
    while (i < xml.length) {
      while (i < xml.length && isSpace(xml[i])) i++;
      if (xml.startsWith("<?", i)) {
        i = xml.indexOf("?>", i) + 2;
      } else if (xml.startsWith("<!--", i)) {
        i = xml.indexOf("-->", i) + 3;
      } else break;
    }
  }

  function parseElement(): XmlNode {
    // assumes xml[i] === '<' and not a close tag
    i++; // '<'
    const nameStart = i;
    while (i < xml.length && !isSpace(xml[i]) && xml[i] !== ">" && xml[i] !== "/") i++;
    const name = xml.slice(nameStart, i);
    const attrs: XmlNode["attrs"] = [];
    while (i < xml.length) {
      while (i < xml.length && isSpace(xml[i])) i++;
      if (xml[i] === "/" && xml[i + 1] === ">") {
        i += 2;
        return { name, attrs, children: [], text: "" };
      }
      if (xml[i] === ">") {
        i++;
        break;
      }
      const aStart = i;
      while (i < xml.length && xml[i] !== "=" && !isSpace(xml[i])) i++;
      const aName = xml.slice(aStart, i);
      while (i < xml.length && (isSpace(xml[i]) || xml[i] === "=")) i++;
      const quote = xml[i];
      i++;
      const vStart = i;
      while (i < xml.length && xml[i] !== quote) i++;
      const value = decodeEntities(xml.slice(vStart, i));
      i++;
      attrs.push({ name: aName, value });
    }

    // children or text until the matching close tag
    const children: XmlNode[] = [];
    let text = "";
    for (;;) {
      const lt = xml.indexOf("<", i);
      if (lt === -1) break;
      text += xml.slice(i, lt);
      i = lt;
      if (xml.startsWith("</", i)) {
        i = xml.indexOf(">", i) + 1; // consume close tag
        break;
      }
      if (xml.startsWith("<!--", i)) {
        i = xml.indexOf("-->", i) + 3;
        continue;
      }
      children.push(parseElement());
    }
    return {
      name,
      attrs,
      children,
      text: children.length === 0 ? decodeEntities(text.trim()) : "",
    };
  }

  skipProlog();
  return parseElement();
}

/** First direct child element with the given name. */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

/** All direct child elements with the given name. */
export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

/** Trimmed text of a named descendant path (e.g. childText(meta, "PackageName")). */
export function childText(node: XmlNode, name: string): string {
  return child(node, name)?.text ?? "";
}

// ── Writing ─────────────────────────────────────────────────────────────────
// Sitecore's PackageProject writer emits: no XML declaration, no namespaces, no
// attributes, two-space indentation, CRLF line endings, and self-closing `<Tag />`
// (with a leading space) for empty elements. `buildDefinition` reproduces that exactly,
// which is what makes the sample round-trip green — see definition/index.ts.

/** Escape text content. Attributes are never used by this schema, so `"` is left alone. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Accumulates CRLF-separated, two-space-indented lines. */
export class XmlWriter {
  private readonly lines: string[] = [];

  constructor(private readonly indentUnit = "  ") {}

  /** `<name>text</name>`, or `<name />` when the text is empty. */
  leaf(depth: number, name: string, text = ""): void {
    this.lines.push(
      text === ""
        ? this.pad(depth) + "<" + name + " />"
        : this.pad(depth) + "<" + name + ">" + escapeXml(text) + "</" + name + ">",
    );
  }

  /** Open a container element. */
  open(depth: number, name: string): void {
    this.lines.push(this.pad(depth) + "<" + name + ">");
  }

  close(depth: number, name: string): void {
    this.lines.push(this.pad(depth) + "</" + name + ">");
  }

  /**
   * Write a container, or a self-closing `<name />` when `write` produces nothing.
   * This is how the schema's many empty `<Include />` / `<Sources />` elements appear.
   */
  block(depth: number, name: string, write: () => void): void {
    const mark = this.lines.length;
    this.open(depth, name);
    write();
    if (this.lines.length === mark + 1) {
      this.lines[mark] = this.pad(depth) + "<" + name + " />";
      return;
    }
    this.close(depth, name);
  }

  private pad(depth: number): string {
    return this.indentUnit.repeat(depth);
  }

  /** CRLF-joined, with NO trailing newline — the in-package `installer/project` form. */
  toString(): string {
    return this.lines.join("\r\n");
  }
}
