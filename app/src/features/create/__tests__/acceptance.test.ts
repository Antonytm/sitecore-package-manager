// Acceptance: a definition assembled the way the DESIGNER assembles one must serialize to
// exactly what the real Sitecore Package Designer wrote.
//
// The round-trip suite proves we can read a sample and write it back unchanged. That is a
// weaker claim than this: it would still pass if the UI could never *produce* the shape in
// the first place. Here nothing is parsed — the definition is built from `createSource` and
// plain field assignments, the same primitives the panels and dialogs use — and the result
// is compared byte-for-byte against the sample on disk.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDefinition, emptyDefinition } from "@/src/core/definition";
import type { DynamicItemSource, PackageDefinition, StaticItemSource } from "@/src/core/model";
import { DEFINITIONS_DIR } from "@/src/core/__tests__/samples";
import { createSource } from "../sources";

const hasDefinitions = existsSync(DEFINITIONS_DIR);

/** Samples are the downloaded form, which is the in-package form plus one trailing CRLF. */
function readSample(name: string): string {
  return readFileSync(join(DEFINITIONS_DIR, name), "utf8").replace(/\r\n$/, "");
}

/** The metadata every sample shares — what the Metadata panel would have collected. */
function sampleMetadata(): PackageDefinition["metadata"] {
  return {
    name: "Package Name",
    author: "Author",
    version: "1.0.0",
    comment: "Comments",
    attributes: {
      "Custom attribute 1": "Custom attribute 1 value",
      "Custom attribute 2": "Custom attribute 2 value",
    },
    readme: "Readme is here",
    publisher: "Publisher",
    postStep: "post step",
  };
}

describe.skipIf(!hasDefinitions)("a designer-built definition matches Package Designer output", () => {
  it("reproduces the empty package", () => {
    const definition: PackageDefinition = { ...emptyDefinition(), metadata: sampleMetadata() };
    expect(buildDefinition(definition)).toBe(readSample("empty-package.xml"));
  });

  it("reproduces a dynamic item source with all nine filters", () => {
    // Exactly the sequence the UI performs: add a source, pick a root, fill in filters,
    // name it. `createSource` is the same factory the Add ribbon calls.
    const source = createSource("items-dynamic") as DynamicItemSource;
    source.name = "items-dynamically";
    source.database = "master";
    source.root = "{513A5371-AA83-4DB2-A559-E5687586B400}";
    source.include = {
      name: { pattern: "", searchType: "Simple" },
      created: { mode: "within", days: 200 },
      modified: { mode: "within", days: 200 },
      publish: { checkWorkflow: false },
      templates: [
        "{A6C086AD-9651-4912-BC60-512CA5417795}",
        "{37A75481-CA32-4354-8991-A470426AE164}",
        "{0B78E7DE-3C0D-424D-80D6-2BFFFC464885}",
        "{156EB7D8-0059-4C78-BECA-8B8F60DCE7B0}",
        "{31FCB12A-D1D9-41BC-AFE5-1721BE43E55A}",
        "{87DAD559-816C-4C3F-98F6-0AA364047023}",
        "{3B8BAB4B-8626-433B-AFDE-E4031C7A42C3}",
        "{DA1D0F17-CEB5-48C3-9C7B-D52963181BEB}",
      ],
      createdBy: ["sitecore\\antontishchenko@gmail.com"],
      modifiedBy: ["sitecore\\antontishchenko@gmail.com"],
      languages: ["en", "ja-JP", "en-GB", "en-CA"],
    };

    const definition: PackageDefinition = {
      ...emptyDefinition(),
      metadata: sampleMetadata(),
      sources: [source],
    };

    expect(buildDefinition(definition)).toBe(readSample("items-dynamically.xml"));
  });

  it("reproduces a security-accounts source", () => {
    const source = createSource("accounts");
    if (source.kind !== "accounts") throw new Error("expected an account source");
    source.name = "security-accounts";
    source.entries = [
      { type: "roles", domain: "sitecore", name: "Author" },
      { type: "users", domain: "sitecore", name: "antontishchenko@gmail.com" },
    ];

    expect(
      buildDefinition({ ...emptyDefinition(), metadata: sampleMetadata(), sources: [source] }),
    ).toBe(readSample("security-accounts.xml"));
  });

  it("reproduces a dynamic file source", () => {
    const source = createSource("files-dynamic");
    if (source.kind !== "files-dynamic") throw new Error("expected a dynamic file source");
    source.name = "files-dynamically";
    source.root = "/App_Config";
    source.include = {
      name: { pattern: "", acceptDirectories: false },
      created: { mode: "within", days: 200 },
      modified: { mode: "within", days: 200 },
    };

    expect(
      buildDefinition({ ...emptyDefinition(), metadata: sampleMetadata(), sources: [source] }),
    ).toBe(readSample("files-dynamically.xml"));
  });

  it("reproduces the three static item sources, including the deliberate duplicate", () => {
    const sample = readSample("items-statically.xml");

    // Recover the entry lists from the sample so the test stays about SHAPE, not about
    // retyping several hundred item references.
    const blocks = sample.split("<xitems>").slice(1);
    const sources = blocks.map((block) => {
      const source = createSource("items-static") as StaticItemSource;
      source.name = block.match(/<Name>([^<]*)<\/Name>/)?.[1] ?? "";
      source.entries = [...block.matchAll(/<x-item>([^<]*)<\/x-item>/g)].map((m) => {
        const parts = m[1].split("/").filter(Boolean);
        return {
          database: parts[0],
          path: "/" + parts.slice(1, parts.length - 3).join("/"),
          id: parts[parts.length - 3],
          language: parts[parts.length - 2],
          version: Number(parts[parts.length - 1]),
        };
      });
      return source;
    });

    expect(sources).toHaveLength(3);
    expect(sources.map((s) => s.name)).toEqual([
      "static-items-one-by-one",
      "statics-items-recursive",
      "intentional-item-duplicate",
    ]);
    expect(buildDefinition({ ...emptyDefinition(), metadata: sampleMetadata(), sources })).toBe(
      sample,
    );
  });
});
