// Reading a chosen .zip off disk.
//
// The browser call is three lines; everything around it — the size guard and turning a parse
// failure into a sentence a person can act on — is pure and tested. ProjectDialog reads XML
// with `file.text()`; a package is binary, so this is `arrayBuffer()` instead.

import type { PackageModel } from "@/src/core/model";
import { readPackage } from "@/src/core/package";

/**
 * Refuse absurd uploads before spending memory on them. The largest real sample is 69 MB of
 * website files; an items package is far smaller, but the ceiling is generous because the
 * cost of being wrong is only a slow parse.
 */
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

export interface ReadOutcome {
  pkg?: PackageModel;
  error?: string;
}

/** Turn a failure into something actionable rather than a stack trace. */
export function describeReadError(error: unknown, fileName: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/outer zip has no package\.zip/i.test(message)) {
    return (
      fileName +
      " is a zip, but not a Sitecore package: it has no inner package.zip. " +
      "Update packages (.update) and plain archives are not supported."
    );
  }
  if (/invalid|corrupt|signature|eocd/i.test(message)) {
    return fileName + " could not be read as a zip file — it may be truncated or corrupt.";
  }
  return fileName + " could not be read: " + message;
}

export function tooLarge(bytes: number, fileName: string): string | undefined {
  if (bytes <= MAX_PACKAGE_BYTES) return undefined;
  const mb = Math.round(bytes / (1024 * 1024));
  return fileName + " is " + mb + " MB, larger than this app will open in the browser.";
}

export async function readPackageFile(file: File): Promise<ReadOutcome> {
  const oversized = tooLarge(file.size, file.name);
  if (oversized) return { error: oversized };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { pkg: await readPackage(bytes) };
  } catch (e) {
    return { error: describeReadError(e, file.name) };
  }
}
