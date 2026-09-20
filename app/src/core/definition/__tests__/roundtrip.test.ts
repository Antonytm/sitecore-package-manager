// The headline invariant for the definition codec:
//
//     buildDefinition(parseDefinition(xml)) === xml
//
// asserted against every real Package Designer definition in files/samples/definitions/.
// This is what protects the fiddly parts of the schema — element order (including the
// ItemDateFilter / FileDateFilter difference), `<Tag />` self-closing, CRLF endings, the
// trailing `|` on packed attributes, and the bare <Transforms /> on xitems.
//
// Developer-local: self-skips when the git-ignored samples are absent (see samples.ts).

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildDefinition, parseDefinition } from "../index";
import { DEFINITIONS_DIR, EXTRACTED_DIR } from "../../__tests__/samples";

const hasDefinitions = existsSync(DEFINITIONS_DIR);

/**
 * The downloaded `.xml` is the in-package `installer/project` plus one trailing CRLF.
 * buildDefinition emits the in-package form, so compare against the trimmed text.
 */
function readDefinition(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n$/, "");
}

const definitionFiles = hasDefinitions
  ? readdirSync(DEFINITIONS_DIR).filter((f) => f.endsWith(".xml"))
  : [];

describe.skipIf(!hasDefinitions)("definition — byte round-trip", () => {
  it("has samples to check", () => {
    expect(definitionFiles.length).toBeGreaterThan(0);
  });

  for (const file of definitionFiles) {
    it("round-trips " + file, () => {
      const xml = readDefinition(join(DEFINITIONS_DIR, file));
      expect(buildDefinition(parseDefinition(xml))).toBe(xml);
    });
  }
});

describe.skipIf(!hasDefinitions)("definition — semantic parse", () => {
  const parse = (file: string) => parseDefinition(readDefinition(join(DEFINITIONS_DIR, file)));

  it("reads metadata and custom attributes", () => {
    const { metadata, saveProject } = parse("empty-package.xml");
    expect(metadata.name).toBe("Package Name");
    expect(metadata.version).toBe("1.0.0");
    expect(metadata.author).toBe("Author");
    expect(metadata.postStep).toBe("post step");
    expect(metadata.attributes?.["Custom attribute 1"]).toBe("Custom attribute 1 value");
    expect(saveProject).toBe(true);
  });

  it("reads static item sources, keeping language and version scoping", () => {
    const { sources } = parse("items-statically.xml");
    const statics = sources.filter((s) => s.kind === "items-static");
    expect(statics).toHaveLength(3);
    const first = statics[0];
    if (first.kind !== "items-static") throw new Error("expected a static item source");
    expect(first.name).toBe("static-items-one-by-one");
    expect(first.skipVersions).toBe(false);
    for (const e of first.entries) {
      expect(e.database).toBe("master");
      expect(e.id).toMatch(/^\{[0-9A-Fa-f-]{36}\}$/);
      expect(e.language).toBe("invariant");
      expect(e.version).toBe(0);
      expect(e.path.startsWith("/sitecore/content/")).toBe(true);
    }
  });

  it("reads a dynamic item source with root and all nine filters", () => {
    const { sources } = parse("items-dynamically.xml");
    const dyn = sources.find((s) => s.kind === "items-dynamic");
    if (dyn?.kind !== "items-dynamic") throw new Error("expected a dynamic item source");
    expect(dyn.database).toBe("master");
    expect(dyn.root).toBe("{513A5371-AA83-4DB2-A559-E5687586B400}");
    expect(dyn.include.created).toEqual({ mode: "within", days: 200 });
    expect(dyn.include.modified).toEqual({ mode: "within", days: 200 });
    expect(dyn.include.publish?.checkWorkflow).toBe(false);
    expect(dyn.include.templates).toHaveLength(8);
    expect(dyn.include.languages).toEqual(["en", "ja-JP", "en-GB", "en-CA"]);
    expect(dyn.include.createdBy).toEqual(["sitecore\\antontishchenko@gmail.com"]);
    expect(dyn.include.modifiedBy).toEqual(["sitecore\\antontishchenko@gmail.com"]);
    expect(dyn.behaviour).toEqual({ itemMode: "Undefined", itemMergeMode: "Undefined" });
  });

  it("reads a dynamic file source with its converter root", () => {
    const { sources } = parse("files-dynamically.xml");
    const dyn = sources.find((s) => s.kind === "files-dynamic");
    if (dyn?.kind !== "files-dynamic") throw new Error("expected a dynamic file source");
    expect(dyn.root).toBe("/App_Config");
    expect(dyn.converterRoot).toBe("/");
    expect(dyn.include.name?.acceptDirectories).toBe(false);
    expect(dyn.include.created).toEqual({ mode: "within", days: 200 });
  });

  it("reads static file entries, including directory entries", () => {
    const { sources } = parse("flies-statically.xml");
    const stat = sources.find((s) => s.kind === "files-static");
    if (stat?.kind !== "files-static") throw new Error("expected a static file source");
    expect(stat.name).toBe("files-bin");
    expect(stat.entries).toContain("/bin/");
    expect(stat.entries).toContain("/bin/AjaxMin.dll");
  });

  it("reads security accounts as typed role/user refs", () => {
    const { sources } = parse("security-accounts.xml");
    const accounts = sources.find((s) => s.kind === "accounts");
    if (accounts?.kind !== "accounts") throw new Error("expected an account source");
    expect(accounts.entries).toEqual([
      { type: "roles", domain: "sitecore", name: "Author" },
      { type: "users", domain: "sitecore", name: "antontishchenko@gmail.com" },
    ]);
  });
});

// The in-package copy is the same document without the trailing CRLF — confirm the
// writer targets that form, since it is what a generated package must embed.
describe.skipIf(!existsSync(EXTRACTED_DIR))("definition — in-package form", () => {
  it("round-trips the embedded installer/project byte-for-byte", () => {
    const path = join(EXTRACTED_DIR, "items-dynamically", "inner", "installer", "project");
    if (!existsSync(path)) return;
    const xml = readFileSync(path, "utf8");
    expect(xml.endsWith(">")).toBe(true);
    expect(buildDefinition(parseDefinition(xml))).toBe(xml);
  });
});
