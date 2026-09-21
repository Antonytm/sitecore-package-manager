// Which frame are we in, and whose page is hosting us?
//
// The app is a Marketplace extension: normally an iframe inside the Sitecore Cloud Portal at
// https://app.sitecorecloud.io. During development it is often something else — a localhost
// dev server opened directly, or a local extension URL embedded by a different host. That is
// a perfectly normal state, and the point of showing it is so a developer or content manager
// can see WHICH environment and host are in use, not to flag a problem.
//
// A cross-origin parent's URL cannot be read, so this is a best-effort identification from the
// two things a child frame is allowed to see:
//
//   location.ancestorOrigins  exact, ordered, but Chromium/WebKit only
//   document.referrer         the embedding page's URL on the initial navigation, and trimmed
//                             to nothing (or to bare origin) by some referrer policies
//
// Split in two on purpose: `readEmbeddingProbe` is the only thing that touches `window`, so
// `describeEmbedding` stays a pure function and is testable under vitest's node environment
// (there is no jsdom in this project, and none is being added).

/** The raw browser facts. Produced by {@link readEmbeddingProbe}, consumed by {@link describeEmbedding}. */
export interface EmbeddingProbe {
  /** True when we are the top-level document — i.e. not embedded at all. */
  isTop: boolean;
  /** Ancestor frame origins, nearest first. Empty where the browser does not implement it. */
  ancestorOrigins: string[];
  /** `document.referrer`; may be a full URL, a bare origin, or empty. */
  referrer: string;
  /** Our own origin. */
  appOrigin: string;
}

/**
 * What kind of page is hosting us.
 *
 * `unknown` is a real answer and not a synonym for `other`: it means we are embedded but no
 * detection channel answered, which must not be reported as "some other host".
 */
export type HostKind = "portal" | "sitecore-other" | "other" | "not-embedded" | "unknown";

/** Which channel identified the host. */
export type DetectedVia = "ancestorOrigins" | "referrer" | "none";

export interface EmbeddingInfo {
  embedded: boolean;
  /** The immediate parent's origin, when one could be determined. */
  hostOrigin?: string;
  appOrigin: string;
  kind: HostKind;
  detectedVia: DetectedVia;
  /** True when the app itself is served from a loopback address. */
  appIsLocal: boolean;
  /** Ready to render in a chip: `app.sitecorecloud.io`, `localhost:3000`, `not embedded · …`. */
  label: string;
}

/** The production Cloud Portal. The one origin that counts as "the real thing". */
export const PORTAL_ORIGIN = "https://app.sitecorecloud.io";

/**
 * Host suffixes the Marketplace SDK itself accepts messages from (`core`'s `AllowedOrigins`).
 * Anything under these is Sitecore-operated but not the production portal — staging, previews.
 */
export const SITECORE_HOST_SUFFIXES = [
  "sitecorecloud.io",
  "sitecorecloud.app",
  "sitecore-staging.cloud",
];

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** `https://app.sitecorecloud.io` → `app.sitecorecloud.io`; passes anything unparseable through. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function hostnameOf(origin: string): string | undefined {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

/** The origin of a full URL. Returns undefined for "", "about:client" and other non-URLs. */
function originOf(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    // `new URL("about:blank").origin` is the string "null" — not an origin we can report.
    return origin && origin !== "null" ? origin : undefined;
  } catch {
    return undefined;
  }
}

function isLoopback(origin: string): boolean {
  const hostname = hostnameOf(origin);
  return hostname !== undefined && LOOPBACK_HOSTNAMES.includes(hostname);
}

function classify(hostOrigin: string | undefined): HostKind {
  if (!hostOrigin) return "unknown";
  if (hostOrigin === PORTAL_ORIGIN) return "portal";
  const hostname = hostnameOf(hostOrigin);
  if (
    hostname !== undefined &&
    SITECORE_HOST_SUFFIXES.some((s) => hostname === s || hostname.endsWith("." + s))
  ) {
    return "sitecore-other";
  }
  return "other";
}

/**
 * Identify the host from the raw probe. Pure.
 *
 * `ancestorOrigins` wins over `referrer` because it is exact and current, whereas the referrer
 * only describes the navigation that created this document and can be stale or trimmed.
 */
export function describeEmbedding(probe: EmbeddingProbe): EmbeddingInfo {
  const appIsLocal = isLoopback(probe.appOrigin);

  if (probe.isTop) {
    return {
      embedded: false,
      appOrigin: probe.appOrigin,
      kind: "not-embedded",
      detectedVia: "none",
      appIsLocal,
      label: "not embedded · " + hostOf(probe.appOrigin),
    };
  }

  const fromAncestors = probe.ancestorOrigins.find((o) => originOf(o) !== undefined);
  const hostOrigin = fromAncestors
    ? originOf(fromAncestors)
    : originOf(probe.referrer);
  const detectedVia: DetectedVia = fromAncestors
    ? "ancestorOrigins"
    : hostOrigin
      ? "referrer"
      : "none";

  const kind = classify(hostOrigin);

  return {
    embedded: true,
    hostOrigin,
    appOrigin: probe.appOrigin,
    kind,
    detectedVia,
    appIsLocal,
    label: hostOrigin ? hostOf(hostOrigin) : "embedded · host unknown",
  };
}

/**
 * Read the browser facts. The ONLY function here that touches `window`.
 *
 * Must not run at module load: these modules are evaluated during Next's prerender, where
 * `window` does not exist. Call it from an effect. Every access is guarded because
 * `ancestorOrigins` is not implemented everywhere and a sandboxed frame can make even
 * `window.top` throw.
 */
export function readEmbeddingProbe(): EmbeddingProbe {
  const guard = <T,>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  return {
    isTop: guard(() => window.top === window.self, true),
    ancestorOrigins: guard(
      () =>
        Array.from(
          (window.location as unknown as { ancestorOrigins?: DOMStringList }).ancestorOrigins ??
            [],
        ),
      [],
    ),
    referrer: guard(() => document.referrer, ""),
    appOrigin: guard(() => window.location.origin, ""),
  };
}
