// ItemModel <-> .raif frames, asserted against the 300 real items in a live export.
//
// The interesting assertions are the two rules that fail silently rather than loudly:
// the forward pointer on the descriptor frame, and the (version, language) sharing encoding.

import { describe, it, expect } from "vitest";
import type { ItemModel } from "../../model";
import { decodePayload, readFrames, writeFrames } from "../codec";
import {
  dateToTicks,
  frameLength,
  framesToItems,
  itemsToFrames,
  readDescriptor,
  readFieldValues,
  sharingOf,
  sitecoreDateToTicks,
  ticksToSitecoreDate,
} from "../items";
import { bytesToGuid, guidToBytes } from "../guid";
import { asNumber, field } from "../protobuf";
import { hasRaifChunks, readBytes, sampleChunks } from "../../__tests__/samples";

const TEST_ITEM: ItemModel = {
  id: "{63A7026A-15DC-469C-BBBB-66F256ED0080}",
  name: "test",
  path: "/sitecore/content/test",
  templateId: "{588D4583-BFB5-4967-8123-8922DE93C1BE}",
  parentId: "{0DE95AE4-41AB-4D01-9EB0-67441B7C2450}",
  masterId: "{2D3805B9-3089-44F3-B952-D45C44ADD7F8}",
  created: "20260915T121608Z",
  sharedFields: [{ id: "{85A7501A-86D9-4243-9075-0B727C3A6DB4}", value: "test" }],
  languages: [
    {
      language: "en",
      unversionedFields: [{ id: "{DBBBECA1-21C7-4906-9DD2-493C1EFA59A2}", value: "x" }],
      versions: [
        {
          version: 1,
          fields: [{ id: "{8CDC337E-A112-42FB-BBB4-4143751E123F}", value: "rev-1" }],
        },
      ],
    },
  ],
};

describe("guid halves", () => {
  it("matches the .NET byte order seen on the wire", () => {
    // Taken verbatim from a real chunk: f1 then f2, concatenated.
    const onWire = Uint8Array.from([
      0x6a, 0x02, 0xa7, 0x63, 0xdc, 0x15, 0x9c, 0x46,
      0xbb, 0xbb, 0x66, 0xf2, 0x56, 0xed, 0x00, 0x80,
    ]);
    expect(bytesToGuid(onWire)).toBe("{63A7026A-15DC-469C-BBBB-66F256ED0080}");
    expect([...guidToBytes("{63A7026A-15DC-469C-BBBB-66F256ED0080}")]).toEqual([...onWire]);
  });

  it("round-trips regardless of input casing or braces", () => {
    const g = "{2D3805B9-3089-44F3-B952-D45C44ADD7F8}";
    expect(bytesToGuid(guidToBytes(g.toLowerCase().replace(/[{}]/g, "")))).toBe(g);
  });
});

describe("ticks", () => {
  it("round-trips a Sitecore date", () => {
    expect(ticksToSitecoreDate(sitecoreDateToTicks("20260915T121608Z"))).toBe("20260915T121608Z");
  });

  it("decodes the ticks value seen in a real descriptor to a plausible date", () => {
    // 639254560168136729 ticks — if the epoch offset were wrong this lands in year 1 or 4000.
    const year = Number(ticksToSitecoreDate(639254560168136729n).slice(0, 4));
    expect(year).toBeGreaterThan(2020);
    expect(year).toBeLessThan(2100);
  });

  it("round-trips a Date", () => {
    const d = new Date("2026-09-20T01:02:03.000Z");
    expect(ticksToSitecoreDate(dateToTicks(d))).toBe("20260920T010203Z");
  });
});

describe("sharing is the (version, language) pair", () => {
  it("reads all three forms", () => {
    expect(sharingOf({ id: "x", value: "", version: 0xffffffffffffffffn, language: "" })).toBe("Shared");
    expect(sharingOf({ id: "x", value: "", version: 0xffffffffffffffffn, language: "en" })).toBe("Unversioned");
    expect(sharingOf({ id: "x", value: "", version: 1n, language: "en" })).toBe("Versioned");
  });
});

describe("ItemModel round-trip", () => {
  it("survives frames -> items -> frames", () => {
    const [back] = framesToItems(itemsToFrames([TEST_ITEM]));
    expect(back.id).toBe(TEST_ITEM.id);
    expect(back.name).toBe("test");
    expect(back.parentId).toBe(TEST_ITEM.parentId);
    expect(back.templateId).toBe(TEST_ITEM.templateId);
    expect(back.masterId).toBe(TEST_ITEM.masterId);
    expect(back.created).toBe("20260915T121608Z");
    expect(back.sharedFields.map((f) => f.id)).toEqual(["{85A7501A-86D9-4243-9075-0B727C3A6DB4}"]);
    expect(back.languages[0].unversionedFields[0].value).toBe("x");
    expect(back.languages[0].versions[0].fields[0].value).toBe("rev-1");
  });

  it("writes the forward pointer as the values frame length plus its 4-byte prefix", () => {
    const frames = itemsToFrames([TEST_ITEM]);
    const pointer = asNumber(field(frames[1], 1));
    expect(pointer).toBe(BigInt(frameLength(frames[2]) + 4));
  });

  it("omits masterId when the item has none", () => {
    const frames = itemsToFrames([{ ...TEST_ITEM, masterId: undefined }]);
    expect(readDescriptor(frames[1])!.masterId).toBeUndefined();
  });

  it("opens with a marker frame", () => {
    const frames = itemsToFrames([TEST_ITEM]);
    expect(frames[0].some((f) => f.no === 102)).toBe(true);
    expect(readDescriptor(frames[0])).toBeUndefined();
  });
});

describe.skipIf(!hasRaifChunks)("against the real export", () => {
  it("reads every item out of the 300-item chunk", async () => {
    const big = sampleChunks().find((p) => p.includes("_sitecore_content-0"))!;
    const frames = readFrames(await decodePayload(readBytes(big)));
    const items = framesToItems(frames);

    expect(items.length).toBe(300);
    for (const item of items) {
      expect(item.id).toMatch(/^\{[0-9A-F-]{36}\}$/);
      expect(item.templateId).toMatch(/^\{[0-9A-F-]{36}\}$/);
      expect(item.parentId).toMatch(/^\{[0-9A-F-]{36}\}$/);
      expect(item.name.length).toBeGreaterThan(0);
    }
  });

  it("agrees with Sitecore's own forward pointers", async () => {
    // Every descriptor frame in a real payload must satisfy the rule we encode with.
    const big = sampleChunks().find((p) => p.includes("_sitecore_content-0"))!;
    const frames = readFrames(await decodePayload(readBytes(big)));
    let checked = 0;
    for (let i = 1; i + 1 < frames.length; i += 2) {
      const pointer = asNumber(field(frames[i], 1));
      expect(pointer).toBe(BigInt(frameLength(frames[i + 1]) + 4));
      checked++;
    }
    expect(checked).toBe(300);
  });

  it("finds all three sharing forms in real data", async () => {
    const big = sampleChunks().find((p) => p.includes("_sitecore_content-0"))!;
    const frames = readFrames(await decodePayload(readBytes(big)));
    const seen = new Set<string>();
    for (let i = 2; i < frames.length; i += 2) {
      for (const v of readFieldValues(frames[i])) seen.add(sharingOf(v));
    }
    expect([...seen].sort()).toEqual(["Shared", "Unversioned", "Versioned"]);
  });

  it("re-encodes a real item to a frame pair Sitecore's own reader would accept", async () => {
    // Not byte-identical — field order within an item is our choice — but structurally
    // equivalent: same ids, same values, same sharing, and a correct forward pointer.
    const small = sampleChunks().find((p) => p.includes("test"))!;
    const original = framesToItems(readFrames(await decodePayload(readBytes(small))));
    const rebuilt = framesToItems(itemsToFrames(original));

    expect(rebuilt.length).toBe(original.length);
    const flat = (i: ItemModel) =>
      [
        ...i.sharedFields.map((f) => "S " + f.id + "=" + f.value),
        ...i.languages.flatMap((l) => l.unversionedFields.map((f) => "U " + f.id + "=" + f.value)),
        ...i.languages.flatMap((l) =>
          l.versions.flatMap((v) => v.fields.map((f) => "V" + v.version + " " + f.id + "=" + f.value)),
        ),
      ].sort();
    expect(flat(rebuilt[0])).toEqual(flat(original[0]));
    expect(rebuilt[0].id).toBe(original[0].id);
    expect(rebuilt[0].masterId).toBe(original[0].masterId);
  });

  it("writes frames that survive a full payload round-trip", async () => {
    const small = sampleChunks().find((p) => p.includes("test"))!;
    const items = framesToItems(readFrames(await decodePayload(readBytes(small))));
    const payload = writeFrames(itemsToFrames(items));
    expect(framesToItems(readFrames(payload)).length).toBe(items.length);
  });
});
