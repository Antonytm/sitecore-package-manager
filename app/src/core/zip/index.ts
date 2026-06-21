// core/zip — outer+inner ("two-layer") zip read/write.
//
// Classic Sitecore packages are a zip whose payload `package.zip` is itself a zip
// (see wiki/articles/package-format.md). These helpers wrap a zip library (planned:
// `jszip`) behind a tiny interface so the rest of core stays library-agnostic.
//
// TODO: `npm i jszip` and implement against it. Signatures use Uint8Array so this file
// has no external dependency yet and the build stays green.

/** A flat map of entry path → bytes within a single zip layer. */
export type ZipEntries = Map<string, Uint8Array>;

/** Read every entry of a single-layer zip. */
export async function readZip(_bytes: Uint8Array): Promise<ZipEntries> {
  throw new Error("readZip: not implemented — wire up jszip");
}

/** Build a single-layer zip from entries. */
export async function writeZip(_entries: ZipEntries): Promise<Uint8Array> {
  throw new Error("writeZip: not implemented — wire up jszip");
}
