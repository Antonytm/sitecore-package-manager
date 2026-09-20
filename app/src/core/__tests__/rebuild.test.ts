// The acceptance gate for building a package from the model, provable with no tenant.
//
// Read a real Sitecore-generated package, throw away its bytes, rebuild it from the
// semantic model alone, and compare the DECOMPRESSED content of every inner entry.
//
// Byte-identity of the zip framing is impossible — cross-implementation DEFLATE is not
// canonical — but entry content can and must match exactly. That one comparison pins
// attribute order and escaping, field order, empty-field omission, the properties BOM/CRLF,
// `fieldproperties` token order, metadata contents and entry naming, all at once. Wherever
// it cannot be made equal, a decision about Sitecore's behaviour is being made implicitly,
// which is exactly what this forces into the open.

import { describe, it, expect } from "vitest";
import { basename } from "node:path";
import { readPackage, writePackage } from "../package";
import { readZip } from "../zip";
import { hasSamples, samplePackages, readBytes, bytesEqual } from "./samples";

const INNER = "package.zip";

/** The inner archive's entries, name → decompressed bytes, in archive order. */
function innerOf(outerBytes: Uint8Array): { names: string[]; byName: Map<string, Uint8Array> } {
  const inner = readZip(readZip(outerBytes).byName.get(INNER)!.data);
  return {
    names: inner.entries.map((e) => e.name),
    byName: new Map(inner.entries.map((e) => [e.name, e.data])),
  };
}

const show = (b: Uint8Array | undefined) =>
  b === undefined ? "(absent)" : new TextDecoder().decode(b.subarray(0, 400));

describe.skipIf(!hasSamples)("rebuild from model — entry content is byte-equal", () => {
  for (const path of samplePackages()) {
    const name = basename(path);

    it(`rebuilds: ${name}`, async () => {
      const original = readBytes(path);
      const model = await readPackage(original);

      // Drop provenance so writePackage cannot replay the original bytes.
      model.provenance = undefined;
      const rebuilt = await writePackage(model);

      const a = innerOf(original);
      const b = innerOf(rebuilt);

      // Files/security prefixes are carried in the definition but the designer never
      // authors them, and the model has nowhere to keep their bytes — so compare only
      // what the model is meant to round-trip.
      const owned = (n: string) =>
        !n.startsWith("files/") &&
        !n.startsWith("security/") &&
        !n.startsWith("properties/files/");

      // items-statically genuinely contains one entry twice — `alaris`, byte-identical, at
      // positions 16 and 154 — so Sitecore's own `Uniq` sink does not always collapse
      // them. A rebuilt package emits each entry once, which is the correct behaviour, so
      // compare against the original with repeats dropped (first occurrence wins).
      const expected = a.names.filter(owned).filter((n, i, all) => all.indexOf(n) === i);
      expect(b.names).toEqual(expected);

      for (const entry of expected) {
        const want = a.byName.get(entry)!;
        const got = b.byName.get(entry);
        if (!got || !bytesEqual(want, got)) {
          throw new Error(
            "entry differs: " + entry + "\n  want: " + show(want) + "\n  got:  " + show(got),
          );
        }
      }
    });
  }
});
