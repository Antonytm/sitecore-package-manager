# Installing a Package via Content Transfer

How our app applies a classic Sitecore package to SitecoreAI / XM Cloud: convert the package's
items into a `.raif` chunk and push it through the content-transfer API. This is the practical
article — what to call, in what order, what the target actually does with the result, and what it
will not do. The format itself is [[raif-chunk-container]] and [[raif-frame-grammar]]; the
transport is [[content-transfer-api]]. The behaviour this replaces is [[package-installation]].

## Why not the Authoring API

The obvious route is the one we cannot take.

A package is a **graph keyed by GUID**: `__renderings` datasources, droptree and multilist values,
`tid` references, parent ids. Preserving those ids is not a nicety — it is the whole of
correctness. Install items under fresh ids and every internal link silently points at nothing.

All 69 mutations the tenant exposes were enumerated against a live environment. **None can create
an item at a chosen id.**

```
createItemInput            database, fields, language, name, parent, templateId
createItemFromBranchInput  branchId, database, fields, language, name, parent
createItemTemplateInput    baseTemplates, createStandardValuesItem, database, icon,
                           language, name, parent, sections
copyItem / uploadMedia / restoreArchivedItem — no assignable id either

createItem with id / itemId / newItemId / guid
  → "The specified input object field `<x>` does not exist."
```

`executeSerializationCommands` is not present on the schema either. Those were *validation*
errors, so nothing executed and nothing was created.

Content transfer exists to move items **between environments**, so it preserves identity by
construction. That is the entire reason we use it. It is also the same class of judgement the
export side already makes: a result that is silently wrong is worse than a refusal.

## The pipeline

```
package .zip
   │ readPackage                                     (core/, see [[package-format]])
   ▼
PackageModel
   │ parentsFirst                                    fidelity ordering
   │ itemsToFrames                                   [[raif-frame-grammar]]
   │ encodeChunk                                     [[raif-chunk-container]]
   ▼
one .raif chunk
   │ saveChunk(transferId, chunkSetId, 0, bytes)
   │ completeChunkSetTransfer  ──► ContentTransferFileName
   │ consumeFile("blob://" + fileName)               202 Accepted — proves nothing yet
   │ awaitConsume via getBlobState                   → Consumed
   ▼
items live on the target
```

Both `transferId` and `chunkSetId` are minted client-side with `crypto.randomUUID()`.
`createContentTransfer` is a source-side operation and is not required — attempt it if you like,
but do not fail the install when it is refused.

## What the target actually does — two phases ★

This is the part that surprises everyone, and it explains several otherwise baffling symptoms.

**Consuming a `.raif` does not import items into the database.** It registers the file as a
*stacked, read-only data source layered in front of* the database. The items become visible and
readable at their packaged GUIDs immediately, but they physically live in the `.raif`.
`ItemDefinition.IsInTransferSource` is `true` and `SourceName` names the file — the same mechanism
Sitecore uses for items-as-resources.

`StrategyBuilder.BuildStrategy` walks every consumed source for the database and wraps them into a
chain, each source contributing a strategy chosen by the `MergeStrategy` in **its own header
frame**:

| `MergeStrategy` | Strategy class | Effect |
|---|---|---|
| `OverrideExistingItem` | `OverrideExistingItemStrategy` | the source's item wins over the one below |
| `KeepExistingItem` | `KeepExistingItemStrategy` | the existing item wins |
| `OverrideExistingTree` | `OverrideExistingTreeStrategy` | the source's whole subtree replaces what is below |
| `LatestWin` | — | **throws `"not yet implemented"`** |

So the merge strategy is a **read-layering policy**, not a write-time merge. That is a genuinely
different model from the legacy wizard's per-item Overwrite/Merge/Skip
([[installation-wizard-ui]]), and the two do not map cleanly onto one another.

**Then a background agent migrates.** `TransferJobAgent.RunTransferJob` runs **every minute**; for
each database with a not-yet-transferred source it starts `SourceTransferer.StartTransferring`,
which walks every item id in the source and calls `ItemTransferer.Transfer(item)`. That creates a
real database item, copies name / template / branch, saves, reloads, moves it under its proper
parent, then re-creates every version and copies the fields across. Items already transferred are
skipped, so the job is resumable. When all of them succeed the source is marked transfer-complete
and flagged for deletion; otherwise it is marked failed (`TransferState.Failed`) and can be
retried or discarded.

> **Consequences worth planning around.** An install is not finished when `consumeFile` reports
> `Consumed` — that is only phase one. For up to a minute afterwards the items are served from the
> `.raif`, and during that window they **cannot be deleted**: the `uiDeleteItems` pipeline's
> `FilterRaifItems` processor drops any item whose definition `IsInTransferSource` and alerts
> *"Some of selected items are in the RAIF sources and cannot be deleted."* That is exactly the
> error we hit when trying to clean up a probe item straight after installing it.

## Verifying an install

`consumeFile` answers **202 Accepted** whether or not the payload is any good. Everything that can
reject it — a bad scheme, a chunk that will not decrypt, a desynchronised forward pointer —
surfaces only in `getBlobState`. So:

1. Poll `getBlobState` until the state is terminal.
2. Treat `Error` as failure, regardless of the state.
3. Treat *"uploaded but never consumed"* as failure too — a state stuck at `Uploaded` with no
   `ConsumedName` means the consume never started.
4. Only then report success.

The first version of our installer reported success while the state was still `Initializing`,
because only `Uploaded` counted as pending. The item happened to land, so the run looked clean — a
rejected payload would have looked equally clean.

A chunk is applied as **one unit**. There is no partial success to report: if it fails, nothing
from it landed, so every item in it is a failure.

### The key-rotation pre-flight

Our encoder depends on a key compiled into a Sitecore assembly ([[raif-chunk-container]]). If it
is ever rotated, chunks we write become undecryptable on the target and installs fail with no
useful diagnosis. The cheap guard is to **pull a chunk from the environment and decode it before
writing anything** — `exportSubtree` exists for this.

## What this does not do

Stated plainly, because a silently partial install is worse than a refused one:

- **Media.** We do not write blob frames yet, so media fields will resolve to missing media. The
  format supports it ([[raif-frame-grammar]]) and media travels in its own chunks flagged
  `isMedia`, but no sample we hold contains one.
- **`files/` sources.** There is no server file system on XM Cloud ([[package-format]]).
- **`security/` accounts.** Identity lives in the Cloud Portal ([[security-accounts]]).
- **Post-steps.** A package's `PostStep` is arbitrary .NET; it cannot run here.
- **Uninstall.** There is no installation history, no stored revisions and no rollback — the
  compensating control is a read-only "what will change" step before the write, not an undo after
  it.
- **`SideBySide` install mode.** It has no counterpart in the transfer strategies.

## SitecoreAI implementation notes

- `app/src/xmc/install.ts` is this pipeline; `app/src/xmc/plan.ts` is the read-only pre-flight that
  classifies each item as create / update / blocked, and deliberately runs the *same* existence
  pass the installer needs rather than a second, subtly different one.
- We currently push the whole package as **one chunk**. Sitecore's own writer splits at 300 items
  (or 100 MB of media), so large packages should follow that rule — and continuation chunks must
  carry flag byte `0`.
- `mergeStrategy` is accepted as an option but not yet written into the header frame. Since the
  header's default is `OverrideExistingItem`, that is today's effective behaviour.
- The per-item collision dialog the legacy wizard offers cannot be implemented on top of the
  transfer strategies alone — they are per-source, not per-item. Honest options are to apply one
  strategy per install, or to partition the package into several chunk sets.

## Sources

- Live end-to-end run against an XM Cloud tenant: authored a one-item chunk from a real `.zip`, pushed it, and read the item back by `itemId` — it landed at the GUID the package claimed (primary ground truth for the whole premise), 2026-09-20.
- Enumeration of all 69 Authoring mutations on the live tenant's schema, 2026-09-20.
- Decompiled `Sitecore.Data.Transfer.{ItemTransferer,SourceTransferer}`, `Sitecore.Data.Transfer.Strategies.{StrategyBuilder,StackableStrategy,OverrideExistingItemStrategy,KeepExistingItemStrategy,OverrideExistingTreeStrategy}`, `Sitecore.Data.Transfer.{ConsumeFileStatus,TransferState}`, `Sitecore.Data.Transfer.ItemExtensions`, `Sitecore.Shell.Framework.Pipelines.DeleteItems.FilterRaifItems`, 2026-09-20.
- Shipped `App_Config/Sitecore/CMS.Core/Sitecore.ContentTransfer.config` (the one-minute `TransferJobAgent`), 2026-09-20.
- Our implementation: `app/src/xmc/{install,plan,transfer}.ts`, 2026-09-20.
