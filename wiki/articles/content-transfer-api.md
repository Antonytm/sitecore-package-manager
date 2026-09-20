# Content Transfer API (XM Cloud)

The HTTP surface that moves `.raif` chunks in and out of an XM Cloud environment, reached from a
Marketplace app as `xmc.contentTransfer.*`. It is the transport under our installer, and the only
authorised route that can write items at their own GUIDs ([[content-transfer-install]] explains
why that matters). The bytes it carries are [[raif-chunk-container]] and [[raif-frame-grammar]].

Sitecore documents none of this. Everything below is either read off the decompiled
`Sitecore.ContentTransfer.Data.Api.Controllers.ContentTransferController` and its services, or
learned by calling the live API through the Marketplace SDK and watching what came back.

## Two shapes to get right before anything works

Both of these were found the hard way, and both fail in ways that point at the wrong cause.

> **Every operation needs `sitecoreContextId`.** Without it the gateway answers **404 "No sitecore
> context"**, which reads as a missing endpoint rather than a missing parameter. Send it as a
> `query` value on every call — and *omit* it rather than sending `undefined`, because a
> present-but-empty value is treated as absent.

> **Responses are double-wrapped.** The SDK's envelope wraps the service's own, so the useful body
> is at `result.data.data`. Reading `result.data` yields an object that looks plausible and has
> none of the fields you want. Service bodies are also **PascalCase** (`State`,
> `ChunkSetsMetadata`, `BlobState`), not the camelCase the SDK's types suggest.

## Routes

The chunked API lives at `sitecore/api/content/transfer/v1`:

```
POST   transfers                                                      create a transfer
GET    transfers/{transferId}/status                                  poll it
DELETE transfers/{transferId}                                         clean up
GET    transfers/{transferId}/chunksets/{chunksetId}/chunks/{chunkId} download a chunk
                                                      ← response header  IsMedia: true|false
PUT    transfers/{transferId}/chunksets/{chunksetId}/chunks/{chunkId}?isMedia=<bool>
POST   transfers/{transferId}/chunksets/{chunksetId}/complete         seal the set
```

Note the spelling: the path segment is **`chunksetId`**, lower-case `s`, even though the JSON
bodies use `ChunkSetId`.

There is a second, older surface in the Kernel at `sitecore/shell/api[/v2]/ItemsTransfer/…`
(`ConsumeFile`, `GetBlobState`, `UploadBlob`, `Retry`, `Discard`, `Explore`, `ListItems`). The
Marketplace SDK's `consumeFile` / `getBlobState` operations land there. It is worth knowing it
exists when an error message does not match the v1 controller.

## Operations

As exposed by the Marketplace SDK. `verb` is the SDK call — getting it wrong is a silent 404.

| Operation | Verb | Parameters | Returns |
|---|---|---|---|
| `createContentTransfer` | `mutate` | body `{ transferId, configuration: { dataTrees } }` | — |
| `getContentTransferStatus` | `query` | path `{ transferId }` | `State`, `ChunkSetsMetadata[]` |
| `getChunk` | `query` | path `{ transferId, chunksetId, chunkId }` | chunk bytes |
| `saveChunk` | `mutate` | path `{ transferId, chunksetId, chunkId }`, query `isMedia?`, **body: `Blob`** | — |
| `completeChunkSetTransfer` | `mutate` | path `{ transferId, chunksetId }` | `ContentTransferFileName` |
| `consumeFile` | `query` | query `{ databaseName, fileName }` | 202 Accepted |
| `getBlobState` | `query` | query `{ fileName }` | `BlobState`, `Error`, `ConsumedName` |
| `deleteContentTransfer` | `mutate` | path `{ transferId }` | — |

`transferId` and `chunkSetId` are **minted by the caller** (`crypto.randomUUID()`); the service
does not hand them out.

### Vocabulary

```csharp
DataTree      { string ItemPath; TreeScope Scope; MergeStrategy MergeStrategy; }
TreeScope     SingleItem | ItemAndDescendants
MergeStrategy OverrideExistingItem | KeepExistingItem | LatestWin | OverrideExistingTree
```

> **`LatestWin` is not implemented.** `StrategyBuilder.ResolveFromSource` throws
> `InvalidOperationException("Strategy 'LatestWin' is not yet implemented.")`. Three of the four
> enum values work; the fourth compiles, serialises and then fails at apply time on the target.

A transfer produces **one chunk set per distinct `MergeStrategy`** among its data trees, because
the strategy is written into each chunk set's header frame ([[raif-frame-grammar]]).

## Lifecycle

```
pull (export)   createContentTransfer ──► poll getContentTransferStatus ──► getChunk × N
                                             State: … → Completed
                                          then always deleteContentTransfer

push (install)  saveChunk × N ──► completeChunkSetTransfer ──► consumeFile ──► poll getBlobState
                                   └► ContentTransferFileName      202          → Consumed
```

### Undocumented behaviour, each with its symptom

- **`consumeFile` needs a scheme on the file name.** A bare name is rejected with *"Allowed schema
  is not specified"*. Use `blob://<name>` for a chunk pushed with `saveChunk` (it lives in blob
  storage); `file://` is for a name already on disk. Because the call answers **202 either way**,
  this rejection is completely invisible unless you poll afterwards.
- **`getBlobState` answers `BlobState`**, not the `status` the SDK's own types advertise, together
  with `Error` and `ConsumedName`. The lifecycle is `Uploaded → Initializing → Consumed`.
- **`saveChunk`'s body must be a `Blob`.** Sending a bare `Uint8Array` goes out as JSON, and the
  service stores something that will never decrypt — a failure that surfaces much later, at
  consume, as a generic rejection.
- **`createContentTransfer` is a source-side operation.** On the push side it answers *"DataTrees
  are empty or missing"*, and the install works without it. Only `saveChunk` onwards is required.
- **`completeChunkSetTransfer` returns the assembled file name** (`ContentTransferFileName`) — that
  is the name `consumeFile` then takes. Generated as
  `contentTransfer-{transferId}-{chunkSetId}.raif`; individual uploads are
  `chunk-{chunkSetId}-{chunkId}.chunk`.
- **The `Content-Digest` header is optional.** `ChecksumService` validates SHA-256 in RFC-9530
  form (`sha-256=:<base64>:`) but **returns success when the header is absent**, logging that the
  integrity check was skipped. If you do send one it must match that exact shape or the request is
  rejected on format alone.

### Polling

There is no callback and no webhook. Both directions poll, and abort can only be honoured
*between* polls — the SDK posts through the parent frame and takes no signal, so an in-flight
request has to land.

`getBlobState` is the one that matters on install, because `consumeFile` returns 202 immediately:
a successful call proves only that the file was queued. Treat `Uploaded`, `Initializing`,
`InProgress`, `Pending`, `Consuming` and `Unknown` as still-working, and **anything unrecognised as
terminal** — that direction is safe, because an unknown state stops the wait rather than spinning
forever.

## Server-side configuration

From the shipped `Sitecore.ContentTransfer.config`, useful when reasoning about timing:

| Setting / agent | Value |
|---|---|
| `Sitecore.TransferredItems.RootFolder` | `$(dataFolder)/sitecore transferred items/` — subfolders named per database |
| `Sitecore.TransferredItems.AzureBlobStorage.*` | connection string and container, from environment variables |
| `TransferJobAgent.RunTransferJob` | **every 1 minute** — picks up a consumed source and migrates it into the database |
| `CleanupTransferBlobsAgent.RunCleanUp` | every 12 hours; deletes `Transferred` blobs older than `BlobLifetimeDays` (default 7) |
| `validateTransferringSource` pipeline | `ValidateUniqueItemIdsProcessor`, `ValidateUniqueBlobIdsProcessor` |
| log | `$(dataFolder)/logs/ContentTransfer.log.{date}.{time}.txt` |

Duplicate item or blob ids inside a source are a **warning, not a rejection** — the validators
emit `ValidationState.Warning` and the source is still consumed.

That one-minute agent is why an install appears to finish and then keeps changing: consuming and
migrating are two separate phases ([[content-transfer-install]]).

## SitecoreAI implementation notes

- `app/src/xmc/transfer.ts` wraps all eight operations behind a single injected `TransferCall`
  seam, so the whole surface is testable without a tenant.
- `unwrap()` peels at most three `data` levels and turns an RFC-7807 body
  (`{ error: { title, detail, status } }`) into a `TransferError` carrying the operation name.
- `exportSubtree()` exists for two reasons: studying the format, and as a **pre-flight** — decoding
  a freshly-pulled chunk proves this environment's key still matches our encoder's before we write
  anything.
- `deleteTransfer` runs in a `finally` with no abort check. Skipping cleanup because the user
  cancelled is how transfers leak.

## Sources

- Live calls against an XM Cloud tenant through `@sitecore-marketplace-sdk/xmc` (primary ground truth — the `blob://` scheme requirement, the `BlobState` field name, the double-wrapped envelope, the `Blob` body requirement and the `createContentTransfer` refusal were each observed, not inferred), 2026-09-20.
- Decompiled `Sitecore.ContentTransfer.Data.Api.Controllers.ContentTransferController` (+ `Constants+Headers`, `Services.ChecksumService`), `Sitecore.ContentTransfer.Data.Pull.Services.{PullService,ChunkStorage,ChunkSet}`, `Sitecore.ContentTransfer.Data.Push.Utils.FileNameGenerator`, `Sitecore.Data.Transfer.Strategies.StrategyBuilder`, `Sitecore.Web.Transfer.ItemsTransferV2Controller`, 2026-09-20.
- Shipped `App_Config/Sitecore/CMS.Core/Sitecore.ContentTransfer.config`, from `files/extracted/files-dynamically/`, 2026-09-20.
- Our client: `app/src/xmc/transfer.ts` and `app/src/xmc/__tests__/transfer.test.ts`, 2026-09-20.
