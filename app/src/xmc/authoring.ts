// xmc/authoring — the raw Authoring GraphQL escape hatch.
//
// The typed `xmc.xmapp.*` operations cover sites and languages, but there is no typed
// operation for generic items, data templates, users or roles — the things the Package
// Designer's pickers browse. All of those go through this one wrapper.
//
// Two shapes to know about:
//
//   * `xmc.authoring.graphql` is registered on the SDK's MutationMap, NOT its QueryMap,
//     so it is invoked with `client.mutate` even for reads.
//   * The result needs unwrapping, and exactly how far depends on the SDK build: `mutate`
//     may hand back the hey-api RequestResult (whose `.data` is the GraphQL envelope
//     `{data, errors}`), or the envelope directly. `unwrapEnvelope` accepts either rather
//     than guessing, because guessing wrong reports "no data" for a call that in fact
//     succeeded.

import type { XmcContext } from "./client";

/** A GraphQL error returned by the Authoring API. */
export interface GraphqlError {
  message?: string;
  /**
   * The response path to the field that failed. Mixed on purpose: GraphQL indexes list
   * entries numerically, so a real path looks like `["a3", "versions", "nodes", 0, "value"]`.
   */
  path?: (string | number)[];
}

/** Thrown when the Authoring API answers with `errors`, or with nothing we can read. */
export class AuthoringError extends Error {
  readonly errors: GraphqlError[];
  /** A structural preview of the raw response, to make a bad shape debuggable. */
  readonly received?: string;
  constructor(message: string, errors: GraphqlError[] = [], received?: string) {
    super(message);
    this.name = "AuthoringError";
    this.errors = errors;
    this.received = received;
  }
}

interface GraphqlEnvelope {
  data?: Record<string, unknown>;
  errors?: GraphqlError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Describe a response shape without dumping potentially large payloads — enough to see
 * which level the envelope actually sits at.
 */
function describeShape(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "[" + value.length + " items]";
  if (!isRecord(value)) return typeof value;
  if (depth >= 2) return "{…}";
  const keys = Object.keys(value).slice(0, 8);
  return (
    "{ " + keys.map((k) => k + ": " + describeShape(value[k], depth + 1)).join(", ") + " }"
  );
}

/**
 * Find the GraphQL envelope wherever the SDK put it.
 *
 * The SDK hands back a hey-api `RequestResult` whose `.data` is the parsed response body
 * — which is itself the GraphQL envelope `{ data, errors }`. So the payload sits two
 * levels down, at `result.data.data`, and both levels have a `data` key.
 *
 * That ambiguity matters: stopping at the FIRST level carrying a `data` record returns
 * the envelope instead of the payload, and every field read off it is silently
 * `undefined` — a successful lookup then looks exactly like "not found". So descend
 * while the next level still looks like a wrapper, and keep the deepest envelope.
 *
 * `errors` is captured at whichever level carries it, since a GraphQL error response has
 * `data: null` and the descent stops there.
 */
function unwrapEnvelope(result: unknown): GraphqlEnvelope | undefined {
  let level: unknown = result;
  let deepest: GraphqlEnvelope | undefined;

  // Three hops is more than the two the SDK actually uses; the bound just stops a
  // pathological payload from walking forever.
  for (let depth = 0; depth < 3 && isRecord(level); depth++) {
    const hasData = isRecord(level.data);
    const hasErrors = Array.isArray(level.errors);
    if (!hasData && !hasErrors) break;

    deepest = {
      data: hasData ? (level.data as Record<string, unknown>) : undefined,
      errors: hasErrors ? (level.errors as GraphqlError[]) : undefined,
    };

    if (!hasData) break;
    level = level.data;
  }
  return deepest;
}

/**
 * An HTTP-level failure, reported as RFC 7807 Problem Details on `result.error`.
 *
 * This is a different failure from a GraphQL `errors` array: the request never reached
 * the resolver. Surfacing `title`/`detail`/`status` verbatim is the difference between a
 * useless "no data" and knowing the request was, say, rejected for a missing context id.
 */
function problemDetails(result: unknown): string | undefined {
  const error = isRecord(result) ? result.error : undefined;
  if (!isRecord(error)) return undefined;
  const parts = [
    typeof error.status === "number" ? String(error.status) : undefined,
    typeof error.title === "string" ? error.title : undefined,
    typeof error.detail === "string" ? error.detail : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" — ") : undefined;
}

/**
 * Run a query (or mutation) against the Sitecore Authoring API and return its `data`.
 *
 * Callers supply the result type; the SDK types the payload only as
 * `Record<string, unknown>`, so this is the boundary where we assert a shape.
 */
export async function authoringGraphql<T>(
  ctx: XmcContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const result = await ctx.client.mutate("xmc.authoring.graphql", {
    params: {
      body: { query, variables: variables ?? {} },
      query: ctx.contextId ? { sitecoreContextId: ctx.contextId } : {},
    },
  });

  const envelope = unwrapEnvelope(result);

  if (envelope?.errors?.length) {
    const first = envelope.errors[0]?.message ?? "unknown error";
    throw new AuthoringError("Authoring API: " + first, envelope.errors);
  }

  if (!envelope?.data) {
    // Log the whole response so it can be inspected in DevTools; the thrown message
    // carries only a compact shape, since it is rendered in the UI.
    console.error("[package-manager] unreadable Authoring API response", {
      result,
      query: query.trim().split("\n")[0],
      variables,
      contextId: ctx.contextId ? "(set)" : "(missing)",
    });

    // An HTTP-level failure carries the useful text; prefer it over a generic message.
    const problem = problemDetails(result);
    if (problem) {
      throw new AuthoringError(
        "Authoring API: " + problem +
          (ctx.contextId
            ? ""
            : ". No Sitecore context id was available, so the request could not be routed to your tenant."),
        [],
        describeShape(result),
      );
    }

    throw new AuthoringError(
      "Authoring API returned no data" +
        (ctx.contextId ? "" : " — no Sitecore context id was available"),
      [],
      describeShape(result),
    );
  }

  return envelope.data as T;
}

/** A response that may carry data and errors at the same time. */
export interface PartialResult<T> {
  data?: T;
  errors: GraphqlError[];
}

/**
 * Like {@link authoringGraphql}, but hands back data and errors together instead of
 * throwing on the first error.
 *
 * GraphQL routinely answers with partial data: one unreadable item nulls its own field and
 * adds an error keyed by `path`, while every sibling resolves fine. `authoringGraphql`
 * throws in that case and discards `envelope.data`, which is the right call for the
 * pickers and for Preview — one alias per request, so an error means the request failed.
 *
 * Export batches ~25 items into a single aliased document, where that contract would let
 * one inaccessible item destroy the other 24 and then fail identically on retry. So this
 * exists alongside rather than replacing it: the existing behaviour is depended on, and a
 * per-item error is only actionable if the items that DID resolve survive.
 *
 * A transport-level failure is still thrown — nothing resolved, so there is no partial
 * result to reason about.
 */
export async function authoringGraphqlPartial<T>(
  ctx: XmcContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<PartialResult<T>> {
  const result = await ctx.client.mutate("xmc.authoring.graphql", {
    params: {
      body: { query, variables: variables ?? {} },
      query: ctx.contextId ? { sitecoreContextId: ctx.contextId } : {},
    },
  });

  const envelope = unwrapEnvelope(result);
  const errors = envelope?.errors ?? [];

  if (!envelope?.data) {
    if (errors.length > 0) {
      throw new AuthoringError("Authoring API: " + (errors[0]?.message ?? "unknown error"), errors);
    }
    const problem = problemDetails(result);
    throw new AuthoringError(
      "Authoring API: " + (problem ?? "returned no data"),
      [],
      describeShape(result),
    );
  }

  return { data: envelope.data as T, errors };
}
