"use client";

// The source detail panel. Its tab set switches on source kind, exactly as the legacy
// designer did (Screen 10):
//
//   static  →  ENTRIES · INSTALLATION OPTIONS · PREVIEW · NAME
//   dynamic →  SEARCH ROOT · FILTERS · INSTALLATION OPTIONS · PREVIEW · NAME
//
// Kinds the ribbon no longer offers to add — file sources and security accounts — are the
// exception: they get a read-only summary instead. See {@link ReadOnlySourceSummary}.
//
// This used to take `ctx`, `languages` and `onChange` and hand them straight down — it
// never dereferenced the first two at all. They now come from the stores at the point of
// use, so this component only deals with the source it is showing.

import { mdiAlertOutline, mdiTrashCanOutline } from "@mdi/js";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/src/components/ui/tabs";
import { formatAccountRef } from "@/src/core/definition";
import type {
  AccountSource,
  DynamicFileSource,
  SourceDefinition,
  StaticFileSource,
} from "@/src/core/model";
import { SOURCE_LABELS, isDynamic, isFileKind, isReadOnlyKind } from "./sources";
import { EntriesTab } from "./tabs/EntriesTab";
import { ItemFiltersTab } from "./tabs/FiltersTab";
import { InstallOptionsTab } from "./tabs/InstallOptionsTab";
import { NameTab, PreviewTab } from "./tabs/PreviewNameTabs";
import { ItemSearchRootTab } from "./tabs/SearchRootTab";
import { SelectItemsDialog } from "./dialogs/SelectItemsDialog";
import { useDesigner } from "./store/hooks";
import { useSession } from "./store/session";

interface Props {
  source: SourceDefinition;
}

type ReadOnlySource = StaticFileSource | DynamicFileSource | AccountSource;

/**
 * Narrows to {@link ReadOnlySource}.
 *
 * A guard over the source rather than over `source.kind`: TypeScript narrows a union from
 * a discriminant comparison, but not from a predicate applied to the discriminant alone.
 */
function isReadOnly(source: SourceDefinition): source is ReadOnlySource {
  return isReadOnlyKind(source.kind);
}

/** Why this kind is inert here, in the panel's own words. */
function reasonFor(source: ReadOnlySource): string {
  return source.kind === "accounts"
    ? "This source packages Sitecore users and roles. SitecoreAI manages identity in the " +
        "Cloud Portal rather than in the content databases, and the Authoring API does not " +
        "expose accounts — so there is nothing here to pick from and nothing an install " +
        "could create."
    : "This source packages files from the Sitecore server’s file system. SitecoreAI has " +
        "no file system to read them from or install them onto, so it cannot be edited here.";
}

function plural(count: number, noun: string): string {
  return count === 1 ? "1 " + noun : count + " " + noun + "s";
}

/**
 * What a source the ribbon will not create shows instead of an editor.
 *
 * File sources package paths from the Sitecore server's own file system; account sources
 * package users and roles. SitecoreAI has neither in the shape these assume, which is why
 * the ribbon no longer offers to create one.
 *
 * A definition written by the classic Package Designer may still contain them, though, and
 * silently dropping part of someone's package would be worse than not opening it at all.
 * So the source is kept verbatim in the model and re-serialized untouched; this panel just
 * says what it holds and why it is inert.
 */
function ReadOnlySourceSummary({ source }: { source: ReadOnlySource }) {
  const removeSource = useDesigner((s) => s.removeSource);

  return (
    <div className="max-w-2xl space-y-4 p-6 text-sm">
      <p className="flex items-center gap-2 font-medium text-warning-fg">
        <Icon path={mdiAlertOutline} className="size-4 shrink-0" />
        {SOURCE_LABELS[source.kind]} &mdash; not supported here
      </p>

      <p className="text-muted-foreground">{reasonFor(source)}</p>

      <dl className="space-y-1 rounded-md bg-neutral-bg p-3">
        {source.kind === "files-dynamic" ? (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Root:</dt>
            <dd className="font-mono">{source.root || "(not set)"}</dd>
          </div>
        ) : (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">
              {source.kind === "accounts" ? "Accounts:" : "Paths:"}
            </dt>
            <dd>
              {plural(
                source.entries.length,
                source.kind === "accounts" ? "account" : "file path",
              )}
            </dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Name:</dt>
          <dd>{source.name.trim() === "" ? "(unnamed)" : source.name}</dd>
        </div>
      </dl>

      {source.kind === "accounts" && source.entries.length > 0 && (
        <ul className="max-h-40 overflow-auto rounded-md border p-1 font-mono text-xs">
          {source.entries.map((entry) => (
            <li key={formatAccountRef(entry)} className="truncate px-2 py-1">
              {formatAccountRef(entry)}
            </li>
          ))}
        </ul>
      )}

      <p className="text-muted-foreground">
        It is kept exactly as it was, so saving this project leaves the source unchanged.
      </p>

      <Button variant="outline" size="sm" onClick={() => removeSource(source.uid)}>
        <Icon path={mdiTrashCanOutline} className="text-danger-fg" /> Remove source
      </Button>
    </div>
  );
}

export function SourceDetail({ source }: Props) {
  const replaceSource = useDesigner((s) => s.replaceSource);
  const dynamic = isDynamic(source.kind);

  // Keyed by source uid, so switching sources in the left nav cannot leave a tab id that
  // the new source has no TabsContent for — which used to render a blank pane.
  const fallbackTab = dynamic ? "root" : "entries";
  const tab = useSession((s) => s.activeTab[source.uid]) ?? fallbackTab;
  const setActiveTab = useSession((s) => s.setActiveTab);

  const adding = useSession((s) => s.activeDialog?.kind === "entries");
  const openDialog = useSession((s) => s.openDialog);
  const closeDialog = useSession((s) => s.closeDialog);

  if (isReadOnly(source)) {
    return <ReadOnlySourceSummary source={source} />;
  }

  return (
    <>
      <Tabs
        value={tab}
        onValueChange={(next) => setActiveTab(source.uid, next)}
        className="flex h-full flex-col"
      >
        <TabsList className="shrink-0 justify-start rounded-none border-b bg-transparent px-4">
          {dynamic ? (
            <>
              <TabsTrigger value="root">SEARCH ROOT</TabsTrigger>
              <TabsTrigger value="filters">FILTERS</TabsTrigger>
            </>
          ) : (
            <TabsTrigger value="entries">ENTRIES</TabsTrigger>
          )}
          <TabsTrigger value="install">INSTALLATION OPTIONS</TabsTrigger>
          <TabsTrigger value="preview">PREVIEW</TabsTrigger>
          <TabsTrigger value="name">NAME</TabsTrigger>
        </TabsList>

        <div className="flex-1 overflow-auto">
          {!dynamic && (
            <TabsContent value="entries" className="m-0">
              {source.kind === "items-static" && (
                <EntriesTab
                  source={source}
                  onChange={replaceSource}
                  onAddItems={() => openDialog({ kind: "entries" })}
                />
              )}
            </TabsContent>
          )}

          {dynamic && (
            <>
              <TabsContent value="root" className="m-0">
                {source.kind === "items-dynamic" && (
                  <ItemSearchRootTab source={source} onChange={replaceSource} />
                )}
              </TabsContent>

              <TabsContent value="filters" className="m-0">
                {source.kind === "items-dynamic" && (
                  <ItemFiltersTab
                    filters={source.include}
                    onChange={(include) => replaceSource({ ...source, include })}
                  />
                )}
              </TabsContent>
            </>
          )}

          <TabsContent value="install" className="m-0">
            <InstallOptionsTab
              behaviour={source.behaviour}
              // Kept rather than hard-coded true: it states the rule, and stays right if
              // file sources ever reach these tabs again.
              allowMerge={!isFileKind(source.kind)}
              onChange={(behaviour) => replaceSource({ ...source, behaviour })}
            />
          </TabsContent>

          <TabsContent value="preview" className="m-0">
            <PreviewTab source={source} />
          </TabsContent>

          <TabsContent value="name" className="m-0">
            <NameTab
              name={source.name}
              onChange={(name) => replaceSource({ ...source, name })}
            />
          </TabsContent>
        </div>
      </Tabs>

      {adding && source.kind === "items-static" && (
        <SelectItemsDialog
          open
          initialEntries={source.entries}
          initialDatabase={source.entries[0]?.database ?? "master"}
          onCancel={closeDialog}
          onConfirm={(entries, database) => {
            // The database the dialog was set to applies to every entry it produced;
            // dropping it here used to silently discard a database change.
            replaceSource({ ...source, entries: entries.map((e) => ({ ...e, database })) });
            closeDialog();
          }}
        />
      )}
    </>
  );
}
