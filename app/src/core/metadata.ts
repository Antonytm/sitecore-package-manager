// core/metadata — the metadata/ folder.  (files <-> PackageMetadata)
//
// One plain-text file per field (UTF-8, NO BOM, raw value, no trailing newline); custom
// attributes are extra files whose FILENAME is the attribute name. See
// wiki/articles/package-format.md. Round-trips losslessly because values are stored raw.

import type { PackageMetadata } from "./model";

/** Standard metadata files → PackageMetadata keys. */
const FIELD_FILES: Record<string, keyof PackageMetadata> = {
  "sc_name.txt": "name",
  "sc_author.txt": "author",
  "sc_version.txt": "version",
  "sc_publisher.txt": "publisher",
  "sc_readme.txt": "readme",
  "sc_license.txt": "license",
  "sc_poststep.txt": "postStep",
  "sc_comment.txt": "comment",
};
/** Carried through unchanged: meaningful to Sitecore, not authored in the designer. */
const PASSTHROUGH_FILES: Record<string, keyof PackageMetadata> = {
  "sc_revision.txt": "revision",
  "sc_packageid.txt": "packageId",
};

const decode = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);
const encode = (s: string) => new TextEncoder().encode(s);

/**
 * Build {@link PackageMetadata} from the decoded `metadata/` entries (keyed by the file's
 * base name, e.g. "sc_name.txt"). Unknown files become custom `attributes`.
 */
export function readMetadata(files: Map<string, Uint8Array>): PackageMetadata {
  const meta: PackageMetadata = { name: "" };
  const attributes: Record<string, string> = {};
  for (const [fileName, bytes] of files) {
    const value = decode(bytes);
    const key = FIELD_FILES[fileName] ?? PASSTHROUGH_FILES[fileName];
    if (key) {
      (meta as unknown as Record<string, unknown>)[key] = value;
    } else {
      attributes[fileName] = value;
    }
  }
  if (Object.keys(attributes).length > 0) meta.attributes = attributes;
  return meta;
}

/**
 * Serialize {@link PackageMetadata} back to `metadata/` file name → bytes. Standard fields
 * always emit a file (empty when unset, matching the writer); custom attributes emit one
 * file each named after the attribute.
 */
export function writeMetadata(meta: PackageMetadata): Map<string, Uint8Array> {
  const named = new Map<string, string>();
  for (const [fileName, key] of Object.entries({ ...FIELD_FILES, ...PASSTHROUGH_FILES })) {
    named.set(fileName, (meta[key] as string | undefined) ?? "");
  }
  for (const [name, value] of Object.entries(meta.attributes ?? {})) {
    named.set(name, value);
  }
  // Sitecore emits metadata/ in ASCII order ("Custom attribute 1" before "sc_author.txt",
  // uppercase sorting first). Free byte-fidelity, so sort rather than rely on insertion.
  const out = new Map<string, Uint8Array>();
  for (const name of [...named.keys()].sort()) out.set(name, encode(named.get(name)!));
  return out;
}
