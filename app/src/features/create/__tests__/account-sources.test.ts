// Security accounts are read-but-not-authored on SitecoreAI.
//
// XM Cloud manages users and roles in the Cloud Portal rather than in the content
// databases, and the Authoring API does not expose them, so the ribbon no longer offers to
// create an account source. The risk in a change like that is doing it by deleting the
// kind outright, which would quietly drop part of any package a classic Package Designer
// wrote. These cases pin the narrower contract: you cannot ADD one, but an existing one
// survives intact — the same contract file-sources.test.ts pins for the file kinds.

import { describe, it, expect } from "vitest";
import {
  ADD_ORDER,
  SOURCE_ICONS,
  SOURCE_LABELS,
  createSource,
  entryCount,
  isReadOnlyKind,
} from "../sources";
import { buildDefinition, parseDefinition } from "@/src/core/definition";

describe("the Add ribbon", () => {
  it("does not offer security accounts", () => {
    expect(ADD_ORDER).not.toContain("accounts");
  });
});

describe("an existing account source", () => {
  it("keeps a label and an icon, so it still renders in the left nav", () => {
    expect(SOURCE_LABELS.accounts).toBeTruthy();
    expect(SOURCE_ICONS.accounts).toBeTruthy();
  });

  it("is still constructible, since the parser builds one when opening a definition", () => {
    expect(createSource("accounts").kind).toBe("accounts");
  });

  it("reports its entry count for the summary panel", () => {
    expect(entryCount(createSource("accounts"))).toBe(0);
  });

  it("is routed to the read-only summary, like the file kinds", () => {
    expect(isReadOnlyKind("accounts")).toBe(true);
    // The two kinds that are still authorable must not be.
    expect(isReadOnlyKind("items-static")).toBe(false);
    expect(isReadOnlyKind("items-dynamic")).toBe(false);
  });
});

describe("round-tripping a definition that contains an account source", () => {
  // Abridged from files/samples/definitions/security-accounts.xml — enough to prove the
  // source survives a parse/serialize cycle untouched now that the UI will not edit it.
  const XML = [
    "<project>",
    "  <Metadata>",
    "    <metadata>",
    "      <PackageName>Accounts</PackageName>",
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
    "    <accounts>",
    "      <Entries>",
    "        <x-item>roles:sitecore\\Author</x-item>",
    "        <x-item>users:sitecore\\jane</x-item>",
    "      </Entries>",
    "      <Converter>",
    "        <AccountToEntryConverter>",
    "          <Transforms />",
    "        </AccountToEntryConverter>",
    "      </Converter>",
    "      <Include />",
    "      <Exclude />",
    "      <Name>security-accounts</Name>",
    "    </accounts>",
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

  it("parses the account source rather than discarding it", () => {
    const definition = parseDefinition(XML);
    expect(definition.sources).toHaveLength(1);
    expect(definition.sources[0].kind).toBe("accounts");
    expect(definition.sources[0].name).toBe("security-accounts");
  });

  it("keeps both a role and a user entry", () => {
    const source = parseDefinition(XML).sources[0];
    if (source.kind !== "accounts") throw new Error("expected an account source");
    expect(source.entries).toEqual([
      { type: "roles", domain: "sitecore", name: "Author" },
      { type: "users", domain: "sitecore", name: "jane" },
    ]);
  });

  it("writes it back byte-for-byte", () => {
    expect(buildDefinition(parseDefinition(XML))).toBe(XML);
  });
});
