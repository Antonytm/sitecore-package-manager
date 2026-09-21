// The content-transfer client, driven through its injected call seam — no SDK, no network.
//
// The assertions worth having are the two shapes that were found the hard way against a real
// tenant: every request must carry `sitecoreContextId`, and the useful body is two `data`
// levels down. Both fail in ways that look like something else (a 404 that reads as a wrong
// URL; an object with none of the expected fields), so they are pinned here.

import { describe, it, expect } from "vitest";
import type { XmcContext } from "../client";
import {
  awaitConsume,
  awaitTransfer,
  completeChunkSet,
  consumeFile,
  createTransfer,
  deleteTransfer,
  exportSubtree,
  getBlobState,
  getChunk,
  getStatus,
  newTransferId,
  saveChunk,
  TransferError,
  type TransferCall,
} from "../transfer";

interface Recorded {
  kind: string;
  operation: string;
  params: Record<string, unknown>;
}

function ctxWith(responses: Record<string, unknown>) {
  const calls: Recorded[] = [];
  const call: TransferCall = async (kind, operation, params) => {
    calls.push({ kind, operation, params });
    const key = operation.replace("xmc.contentTransfer.", "");
    if (key in responses) {
      const answer = responses[key];
      return typeof answer === "function" ? (answer as () => unknown)() : answer;
    }
    return { data: { data: {} } };
  };
  const ctx = { client: {}, contextId: "ctx-1", database: "master" } as unknown as XmcContext;
  return { ctx, call, calls };
}

/** The real double-wrapped envelope: SDK envelope around the service envelope. */
const wrapped = (body: unknown) => ({ data: { data: body }, status: "success" });

const COMPLETED = wrapped({
  State: "Completed",
  ChunkSetsMetadata: [{ ChunkSetId: "cs-1", ChunkCount: 2, TotalItemCount: 42 }],
});

describe("request shape", () => {
  it("sends sitecoreContextId on every operation", async () => {
    const { ctx, call, calls } = ctxWith({ getContentTransferStatus: COMPLETED });

    await createTransfer(ctx, "t-1", [
      { itemPath: "/sitecore/content", scope: "SingleItem", mergeStrategy: "OverrideExistingItem" },
    ], { call });
    await getStatus(ctx, "t-1", { call });
    // This one is expected to reject (no file name in the stub); we only care that it asked.
    await completeChunkSet(ctx, "t-1", "cs-1", { call }).catch(() => {});
    await deleteTransfer(ctx, "t-1", { call });

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const params = c.params.params as { query?: Record<string, unknown> };
      expect(params.query?.sitecoreContextId).toBe("ctx-1");
    }
  });

  it("omits the context id entirely when there is none, rather than sending undefined", async () => {
    const calls: Recorded[] = [];
    const call: TransferCall = async (kind, operation, params) => {
      calls.push({ kind, operation, params });
      return wrapped({});
    };
    const ctx = { client: {} } as unknown as XmcContext;
    await createTransfer(ctx, "t-1", [], { call });
    const params = calls[0].params.params as { query: Record<string, unknown> };
    expect("sitecoreContextId" in params.query).toBe(false);
  });

  it("uses mutate for writes and query for reads", async () => {
    const { ctx, call, calls } = ctxWith({ getContentTransferStatus: COMPLETED });
    await createTransfer(ctx, "t-1", [], { call });
    await getStatus(ctx, "t-1", { call });
    expect(calls[0].kind).toBe("mutate");
    expect(calls[1].kind).toBe("query");
  });
});

describe("response unwrapping", () => {
  it("reads the body two data levels down", async () => {
    const { ctx, call } = ctxWith({ getContentTransferStatus: COMPLETED });
    const status = await getStatus(ctx, "t-1", { call });
    expect(status.state).toBe("Completed");
    expect(status.chunkSets).toEqual([
      { chunkSetId: "cs-1", chunkCount: 2, totalItemCount: 42 },
    ]);
  });

  it("surfaces an RFC-7807 error instead of returning an empty status", async () => {
    const { ctx, call } = ctxWith({
      getContentTransferStatus: {
        error: { title: "NotFound", detail: "No sitecore context", status: 404 },
      },
    });
    await expect(getStatus(ctx, "t-1", { call })).rejects.toThrow(/NotFound.*404/);
  });

  it("names the operation that failed, not a generic label", async () => {
    // Every transfer error used to be labelled "content transfer", which is no label at
    // all when a pull fails somewhere inside a five-call sequence.
    const { ctx, call } = ctxWith({
      getContentTransferStatus: { error: { title: "NotFound", status: 404 } },
    });
    await expect(getStatus(ctx, "t-1", { call })).rejects.toMatchObject({
      operation: "getContentTransferStatus",
    });
  });

  it("describes an error body that is not the RFC-7807 shape", async () => {
    // Falling back to a bare "request failed" throws away the only evidence there is —
    // which is exactly what a live tenant returned while diagnosing a media pull.
    const { ctx, call } = ctxWith({
      getContentTransferStatus: { error: { reason: "TransferLimitReached", code: 17 } },
    });
    await expect(getStatus(ctx, "t-1", { call })).rejects.toThrow(
      /TransferLimitReached.*17|17.*TransferLimitReached/,
    );
  });

  it("fails createTransfer at the call that was refused", async () => {
    // The response used to be awaited and discarded, so a refused create looked like a
    // success and the run blew up later in the status poll, blaming the wrong operation.
    const { ctx, call } = ctxWith({
      createContentTransfer: { error: { title: "DataTrees are empty or missing", status: 400 } },
    });
    await expect(
      createTransfer(ctx, "t-1", [{ itemPath: "/x", scope: "SingleItem", mergeStrategy: "OverrideExistingItem" }], { call }),
    ).rejects.toMatchObject({ operation: "createContentTransfer" });
  });

  it("reports an unknown state rather than throwing on an empty body", async () => {
    const { ctx, call } = ctxWith({ getContentTransferStatus: wrapped(undefined) });
    expect((await getStatus(ctx, "t-1", { call })).state).toBe("Unknown");
  });
});

describe("awaitTransfer", () => {
  it("polls until Completed", async () => {
    let n = 0;
    const { ctx, call } = ctxWith({
      getContentTransferStatus: () => (++n < 3 ? wrapped({ State: "InProgress" }) : COMPLETED),
    });
    const status = await awaitTransfer(ctx, "t-1", { call, pollMs: 0 });
    expect(status.state).toBe("Completed");
    expect(n).toBe(3);
  });

  it("throws when the service reports failure, rather than polling to the limit", async () => {
    const { ctx, call } = ctxWith({ getContentTransferStatus: wrapped({ State: "Failed" }) });
    await expect(awaitTransfer(ctx, "t-1", { call, pollMs: 0 })).rejects.toThrow(/Failed/);
  });

  it("gives up after maxPolls instead of hanging", async () => {
    const { ctx, call } = ctxWith({ getContentTransferStatus: wrapped({ State: "InProgress" }) });
    await expect(awaitTransfer(ctx, "t-1", { call, pollMs: 0, maxPolls: 2 })).rejects.toThrow(
      /did not complete/,
    );
  });

  it("honours an abort between polls", async () => {
    const controller = new AbortController();
    let n = 0;
    const { ctx, call } = ctxWith({
      getContentTransferStatus: () => {
        if (++n === 2) controller.abort();
        return wrapped({ State: "InProgress" });
      },
    });
    await expect(
      awaitTransfer(ctx, "t-1", { call, pollMs: 0, signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("chunks", () => {
  it("accepts a Blob, an ArrayBuffer or bytes", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    for (const payload of [bytes, bytes.buffer, new Blob([bytes])]) {
      const { ctx, call } = ctxWith({ getChunk: { data: { data: payload } } });
      expect([...(await getChunk(ctx, "t-1", "cs-1", 0, { call }))]).toEqual([1, 2, 3]);
    }
  });

  it("refuses a non-binary chunk rather than corrupting it", async () => {
    const { ctx, call } = ctxWith({ getChunk: wrapped({ oops: true }) });
    await expect(getChunk(ctx, "t-1", "cs-1", 0, { call })).rejects.toThrow(/binary chunk/);
  });

  it("flags media chunks and leaves ordinary ones unflagged", async () => {
    const { ctx, call, calls } = ctxWith({});
    const bytes = Uint8Array.from([1]);
    await saveChunk(ctx, "t-1", "cs-1", 0, bytes, { call });
    await saveChunk(ctx, "t-1", "cs-1", 1, bytes, { call, isMedia: true });

    const q = (i: number) => (calls[i].params.params as { query: Record<string, unknown> }).query;
    expect("isMedia" in q(0)).toBe(false);
    expect(q(1).isMedia).toBe(true);
  });

  it("returns the assembled file name from completeChunkSet", async () => {
    const { ctx, call } = ctxWith({
      completeChunkSetTransfer: wrapped({ ContentTransferFileName: "abc.raif" }),
    });
    expect(await completeChunkSet(ctx, "t-1", "cs-1", { call })).toBe("abc.raif");
  });

  it("refuses to continue when no file name comes back", async () => {
    const { ctx, call } = ctxWith({ completeChunkSetTransfer: wrapped({}) });
    await expect(completeChunkSet(ctx, "t-1", "cs-1", { call })).rejects.toThrow(TransferError);
  });
});

describe("consumeFile", () => {
  const queryOf = (calls: Recorded[]) =>
    (calls[0].params.params as { query: Record<string, unknown> }).query;

  it("qualifies the file name with a scheme", async () => {
    // A bare name is rejected with "Allowed schema is not specified" — and because the call
    // answers 202 either way, that rejection is invisible without polling getBlobState.
    const { ctx, call, calls } = ctxWith({});
    await consumeFile(ctx, "abc.raif", { call });
    expect(queryOf(calls).fileName).toBe("blob://abc.raif");
    expect(queryOf(calls).databaseName).toBe("master");
  });

  it("leaves an already-qualified name alone", async () => {
    const { ctx, call, calls } = ctxWith({});
    await consumeFile(ctx, "file://abc.raif", { call });
    expect(queryOf(calls).fileName).toBe("file://abc.raif");
  });

  it("allows the file:// scheme explicitly", async () => {
    const { ctx, call, calls } = ctxWith({});
    await consumeFile(ctx, "abc.raif", { call, scheme: "file" });
    expect(queryOf(calls).fileName).toBe("file://abc.raif");
  });

  it("allows an explicit database", async () => {
    const { ctx, call, calls } = ctxWith({});
    await consumeFile(ctx, "abc.raif", { call, database: "web" });
    expect(queryOf(calls).databaseName).toBe("web");
  });
});

describe("blob state", () => {
  it("reads BlobState, not the `status` the SDK types advertise", async () => {
    const { ctx, call } = ctxWith({
      getBlobState: wrapped({ BlobState: "Uploaded", Error: null, ConsumedName: null }),
    });
    expect((await getBlobState(ctx, "abc.raif", { call })).status).toBe("Uploaded");
  });

  it("treats Uploaded as pending — it means stored, not consumed", async () => {
    const { ctx, call } = ctxWith({
      getBlobState: wrapped({ BlobState: "Uploaded", Error: null, ConsumedName: null }),
    });
    const state = await awaitConsume(ctx, "abc.raif", { call, pollMs: 0, maxPolls: 2 });
    expect(state.status).toBe("Uploaded");
    expect(state.consumedName).toBeUndefined();
  });

  it("stops as soon as the file is consumed", async () => {
    let n = 0;
    const { ctx, call } = ctxWith({
      getBlobState: () =>
        ++n < 2
          ? wrapped({ BlobState: "Uploaded" })
          : wrapped({ BlobState: "Consumed", ConsumedName: "abc.raif" }),
    });
    const state = await awaitConsume(ctx, "abc.raif", { call, pollMs: 0 });
    expect(state.consumedName).toBe("abc.raif");
    expect(n).toBe(2);
  });

  it("surfaces a consume error rather than polling to the limit", async () => {
    const { ctx, call } = ctxWith({
      getBlobState: wrapped({ BlobState: "Error", Error: "bad payload" }),
    });
    expect((await awaitConsume(ctx, "abc.raif", { call, pollMs: 0 })).error).toBe("bad payload");
  });
});

describe("exportSubtree", () => {
  it("creates, polls, pulls every chunk, and always cleans up", async () => {
    const bytes = Uint8Array.from([9]);
    const { ctx, call, calls } = ctxWith({
      getContentTransferStatus: COMPLETED,
      getChunk: { data: { data: bytes } },
    });
    const chunks = await exportSubtree(ctx, "/sitecore/content", { call, pollMs: 0 });

    expect(chunks.length).toBe(2); // ChunkCount: 2
    const ops = calls.map((c) => c.operation.replace("xmc.contentTransfer.", ""));
    expect(ops[0]).toBe("createContentTransfer");
    expect(ops).toContain("getChunk");
    expect(ops.at(-1)).toBe("deleteContentTransfer");
  });

  it("still deletes the transfer when a chunk pull fails", async () => {
    const { ctx, call, calls } = ctxWith({
      getContentTransferStatus: COMPLETED,
      getChunk: () => {
        throw new Error("boom");
      },
    });
    await expect(exportSubtree(ctx, "/x", { call, pollMs: 0 })).rejects.toThrow("boom");
    expect(calls.at(-1)!.operation).toBe("xmc.contentTransfer.deleteContentTransfer");
  });
});

describe("newTransferId", () => {
  it("mints a distinct uuid each time", () => {
    expect(newTransferId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newTransferId()).not.toBe(newTransferId());
  });
});
