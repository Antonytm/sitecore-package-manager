// File sources are read-but-not-authored on SitecoreAI.
//
// XM Cloud has no server file system, so the ribbon no longer offers to create a file
// source. The risk in a change like that is doing it by deleting the kind outright, which
// would quietly drop part of any package a classic Package Designer wrote. These cases
// pin the narrower contract: you cannot ADD one, but an existing one survives intact.

import { describe, it, expect } from "vitest";
import {
  ADD_ORDER,
  SOURCE_ICONS,
  SOURCE_LABELS,
  createSource,
  entryCount,
  isFileKind,
  isReadOnlyKind,
} from "../sources";
import { buildDefinition, parseDefinition } from "@/src/core/definition";
import type { SourceKind } from "../sources";

const FILE_KINDS: SourceKind[] = ["files-static", "files-dynamic"];

describe("the Add ribbon", () => {
  it("does not offer either file kind", () => {
    for (const kind of FILE_KINDS) expect(ADD_ORDER).not.toContain(kind);
  });

  it("offers only the kinds SitecoreAI can actually resolve", () => {
    expect(ADD_ORDER).toEqual(["items-dynamic", "items-static"]);
  });
});

describe("an existing file source", () => {
  it("keeps a label and an icon, so it still renders in the left nav", () => {
    for (const kind of FILE_KINDS) {
      expect(SOURCE_LABELS[kind]).toBeTruthy();
      expect(SOURCE_ICONS[kind]).toBeTruthy();
    }
  });

  it("is still constructible, since the parser builds one when opening a definition", () => {
    for (const kind of FILE_KINDS) expect(createSource(kind).kind).toBe(kind);
  });

  it("reports its entry count for the summary panel", () => {
    const source = createSource("files-static");
    expect(entryCount(source)).toBe(0);
    // A dynamic source resolves at generation time, so it has no count to show.
    expect(entryCount(createSource("files-dynamic"))).toBeUndefined();
  });

  it("is recognised as a file kind, which is what routes it to the summary", () => {
    for (const kind of FILE_KINDS) expect(isFileKind(kind)).toBe(true);
    expect(isFileKind("items-static")).toBe(false);
    for (const kind of FILE_KINDS) expect(isReadOnlyKind(kind)).toBe(true);
  });
});

describe("round-tripping a definition that contains file sources", () => {
  // Abridged from files/samples/definitions — enough to prove the source survives a
  // parse/serialize cycle untouched now that the UI will not edit it.
  const XML = [
    "<project>",
    "  <Metadata>",
    "    <metadata>",
    "      <PackageName>Files</PackageName>",
    "      <Author />",
    "      <Version />",
    "      <Revision />",
    "      <License />",
    "      <Comment />",
    "      <Attributes />",
    "      <Readme />",
    "      <Publisher />",
    "      <PostStep />",
    "      <PackageID />",
    "    </metadata>",
    "  </Metadata>",
    "  <SaveProject>True</SaveProject>",
    "  <Sources>",
    "    <xfiles>",
    "      <Entries>",
    "        <x-item>/App_Config/Include/Foo.config</x-item>",
    "      </Entries>",
    "      <Converter>",
    "        <FileToEntryConverter>",
    "          <Root>/</Root>",
    "          <Transforms>",
    "            <InstallerConfigurationTransform>",
    "              <Options>",
    "                <BehaviourOptions>",
    "                  <ItemMode>Undefined</ItemMode>",
    "                  <ItemMergeMode>Undefined</ItemMergeMode>",
    "                </BehaviourOptions>",
    "              </Options>",
    "            </InstallerConfigurationTransform>",
    "          </Transforms>",
    "        </FileToEntryConverter>",
    "      </Converter>",
    "      <Include />",
    "      <Exclude />",
    "      <Name>Config files</Name>",
    "    </xfiles>",
    "  </Sources>",
    "  <Converter>",
    "    <TrivialConverter>",
    "      <Transforms />",
    "    </TrivialConverter>",
    "  </Converter>",
    "  <Include />",
    "  <Exclude />",
    "  <Name />",
    "</project>",
  ].join("\r\n");

  it("parses the file source rather than discarding it", () => {
    const definition = parseDefinition(XML);
    expect(definition.sources).toHaveLength(1);
    expect(definition.sources[0].kind).toBe("files-static");
    expect(definition.sources[0].name).toBe("Config files");
  });

  it("writes it back byte-for-byte", () => {
    expect(buildDefinition(parseDefinition(XML))).toBe(XML);
  });
});
