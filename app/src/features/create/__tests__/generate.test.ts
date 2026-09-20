// What Generate ZIP decides, tested away from the dialog.
//
// The .tsx cannot be covered here (vitest is node-only, no jsdom), so the rule is that
// anything worth asserting lives in lib/generate.ts and lib/download.ts and is asserted
// here — most of all the caveats, which are the difference between a package whose gaps
// are known and one whose gaps are discovered on the target.

import { describe, it, expect } from "vitest";
import type { ItemModel, PackageDefinition, SourceDefinition } from "@/src/core/model";
import type { ExportedPackage } from "@/src/xmc/export";
import {
  defaultPackageName,
  generationCaveats,
  generationSummary,
  inertSources,
  toPackageModel,
} from "../lib/generate";
import { packageFileName } from "../lib/download";

const source = (over: Partial<SourceDefinition> = {}): SourceDefinition =>
  ({
    kind: "items-static",
    uid: "u",
    name: "Items",
    behaviour: { itemMode: "Undefined", itemMergeMode: "Undefined" },
    entries: [],
    skipVersions: false,
    ...over,
  }) as SourceDefinition;

const definition = (over: Partial<PackageDefinition> = {}): PackageDefinition => ({
  metadata: { name: "" },
  saveProject: true,
  sources: [],
  ...over,
});

const item = (over: Partial<ItemModel> = {}): ItemModel => ({
  id: "{11111111-1111-1111-1111-111111111111}",
  name: "Home",
  path: "/sitecore/content/Home",
  templateId: "{22222222-2222-2222-2222-222222222222}",
  parentId: "{33333333-3333-3333-3333-333333333333}",
  sharedFields: [],
  languages: [{ language: "en", unversionedFields: [], versions: [{ version: 1, fields: [] }] }],
  ...over,
});

const exported = (over: Partial<ExportedPackage> = {}): ExportedPackage => ({
  items: [],
  problems: [],
  danglingMedia: [],
  duplicates: 0,
  ...over,
});

describe("defaultPackageName", () => {
  it("matches the legacy pre-fill when nothing is named", () => {
    expect(defaultPackageName(definition())).toBe("Unnamed Package.zip");
  });

  it("uses the package name and version when they are set", () => {
    expect(
      defaultPackageName(definition({ metadata: { name: "My Package", version: "1.0.0" } })),
    ).toBe("My Package-1.0.0.zip");
  });

  it("leaves the version out when there is none", () => {
    expect(defaultPackageName(definition({ metadata: { name: "My Package" } }))).toBe(
      "My Package.zip",
    );
  });
});

describe("packageFileName", () => {
  it("adds .zip when it is missing", () => {
    expect(packageFileName("Report")).toBe("Report.zip");
  });

  it("does not double the extension", () => {
    // The legacy default carries `.zip` already, so a user editing it keeps one.
    expect(packageFileName("Report.zip")).toBe("Report.zip");
    expect(packageFileName("Report.ZIP")).toBe("Report.ZIP");
  });

  it("falls back rather than producing a nameless file", () => {
    expect(packageFileName("   ")).toBe("Unnamed Package.zip");
  });
});

describe("toPackageModel", () => {
  it("carries the definition's saveProject through, so installer/project matches it", () => {
    expect(toPackageModel(definition({ saveProject: false }), []).saveProject).toBe(false);
    expect(toPackageModel(definition({ saveProject: true }), []).saveProject).toBe(true);
  });

  it("has no provenance, so writePackage builds rather than replays", () => {
    expect(toPackageModel(definition(), [item()]).provenance).toBeUndefined();
  });
});

describe("inertSources", () => {
  it("names the sources that cannot contribute content here", () => {
    const sources = [
      source({ kind: "items-dynamic" } as Partial<SourceDefinition>),
      source({ kind: "files-static", name: "Files" } as Partial<SourceDefinition>),
      source({ kind: "accounts", name: "Accounts" } as Partial<SourceDefinition>),
    ];
    expect(inertSources(sources).map((s) => s.name)).toEqual(["Files", "Accounts"]);
  });
});

describe("generationCaveats", () => {
  it("says nothing when there is nothing to say", () => {
    expect(generationCaveats(exported(), definition())).toEqual([]);
  });

  it("names the items whose media bytes are missing", () => {
    const lines = generationCaveats(
      exported({ danglingMedia: ["/sitecore/media library/Logo"] }),
      definition(),
    );
    expect(lines[0]).toContain("/sitecore/media library/Logo");
    expect(lines[0]).toContain("install broken");
  });

  it("truncates a long media list rather than flooding the dialog", () => {
    const many = Array.from({ length: 9 }, (_, i) => "/media/" + i);
    const line = generationCaveats(exported({ danglingMedia: many }), definition())[0];
    expect(line).toContain("9 items");
    expect(line).toContain("…");
    expect(line).not.toContain("/media/8");
  });

  it("reports per-item problems", () => {
    const line = generationCaveats(
      exported({ problems: ["/x: its parent is not in the package"] }),
      definition(),
    )[0];
    expect(line).toContain("1 problem");
    expect(line).toContain("parent is not in the package");
  });

  it("explains that file and account sources contribute nothing", () => {
    const line = generationCaveats(
      exported(),
      definition({ sources: [source({ kind: "accounts", name: "Accounts" } as Partial<SourceDefinition>)] }),
    )[0];
    expect(line).toContain("Accounts");
    expect(line).toContain("Cloud Portal");
  });

  it("reports duplicates removed, the way the Uniq sink removes them", () => {
    const line = generationCaveats(exported({ duplicates: 3 }), definition())[0];
    expect(line).toContain("3 duplicate entries");
  });

  it("puts the most serious caveat first", () => {
    const lines = generationCaveats(
      exported({ danglingMedia: ["/m"], duplicates: 1, problems: ["p"] }),
      definition({ sources: [source({ kind: "files-static" } as Partial<SourceDefinition>)] }),
    );
    expect(lines[0]).toContain("media");
    expect(lines[lines.length - 1]).toContain("duplicate");
  });
});

describe("generationSummary", () => {
  it("counts items and their versions", () => {
    const two = item({
      languages: [
        { language: "en", unversionedFields: [], versions: [{ version: 1, fields: [] }, { version: 2, fields: [] }] },
        { language: "da", unversionedFields: [], versions: [{ version: 1, fields: [] }] },
      ],
    });
    expect(generationSummary(exported({ items: [two] }))).toBe("1 item, 3 versions in total.");
  });

  it("is readable when the package is empty", () => {
    expect(generationSummary(exported())).toBe("0 items, 0 versions in total.");
  });
});
