// Handing a generated file to the browser, from inside a cross-origin iframe.
//
// This is the one step of the Create flow that leaves the app, and it is the step most
// likely to be silently blocked: the Marketplace host embeds us in an iframe, and an
// iframe without `allow-downloads` in its sandbox swallows the click with no error and no
// file. That looks exactly like "nothing happened", which is the worst possible outcome
// for a button whose whole job is to produce a file — so failure is reported rather than
// left to be inferred.
//
// The anchor is appended to the document before clicking (a detached anchor's click is
// ignored by some browsers) and the object URL is revoked on a later tick rather than
// synchronously, because revoking it in the same turn can cancel the download that was
// just started.

/** The sandbox permission a download needs; absent, the click goes nowhere. */
function downloadsBlocked(): boolean {
  const sandbox = typeof window !== "undefined" ? window.frameElement?.getAttribute("sandbox") : null;
  // No frameElement (not framed, or cross-origin so we cannot read it) tells us nothing —
  // only an explicitly restrictive sandbox is evidence of a problem.
  if (!sandbox) return false;
  return !sandbox.split(/\s+/).includes("allow-downloads");
}

export interface DownloadResult {
  ok: boolean;
  /** Why it could not be offered, when `ok` is false. */
  reason?: string;
}

/** Offer `data` to the browser as a file named `fileName`. */
export function downloadBytes(
  data: Uint8Array | string,
  fileName: string,
  mimeType: string,
): DownloadResult {
  if (typeof document === "undefined") {
    return { ok: false, reason: "Downloads are only available in the browser." };
  }
  if (downloadsBlocked()) {
    return {
      ok: false,
      reason:
        "This app is embedded in a frame that does not permit downloads, so the browser " +
        "would discard the file without telling you.",
    };
  }

  // `data` may be a view onto a larger buffer; Blob copies what it is given, so pass the
  // view rather than the underlying ArrayBuffer.
  const blob = new Blob([data as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } catch (e: unknown) {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  document.body.removeChild(anchor);
  // Revoking synchronously can cancel the download that was just started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { ok: true };
}

/** Give a package file name the `.zip` the designer's own default carries. */
export function packageFileName(name: string): string {
  const trimmed = name.trim() || "Unnamed Package";
  return /\.zip$/i.test(trimmed) ? trimmed : trimmed + ".zip";
}
