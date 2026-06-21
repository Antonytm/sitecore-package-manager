# Knowledge Wiki

A self-maintaining project knowledge base, following [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): an LLM acts as a *compiler* that turns raw source material into a structured, interlinked Markdown wiki. Knowledge accumulates instead of being rediscovered on every question.

No database, no embeddings, no server — just Markdown files in git.

## Workflow

1. **Collect** — drop raw material (articles, docs, meeting notes, decisions, pasted threads) into `inbox/`
2. **Compile** — run `/wiki-compile` in Claude Code; it reads the inbox, writes/updates articles, links them, and updates the index
3. **View** — open this folder in Obsidian (or any Markdown viewer) — `[[wikilinks]]` form the graph
4. **Ask** — just ask Claude Code questions; it reads `INDEX.md` and follows links

## Layout

| Path | Purpose |
|------|---------|
| `INDEX.md` | One line per article, grouped by topic. The entry point for both humans and the LLM. |
| `articles/` | Compiled articles: `kebab-case-slug.md` |
| `inbox/` | Unprocessed raw sources. Emptied by `/wiki-compile`. |
| `sources/` | Raw sources after compilation (kept for reference / recompilation). |

## Article conventions

- Filename is the topic slug: `articles/package-installation-flow.md`
- Starts with an `# H1 Title`, ends with a `## Sources` section listing origin files/URLs
- Cross-reference other articles with `[[slug]]` wikilinks — link liberally
- Articles are *living documents*: new sources update existing articles rather than creating near-duplicates

## What belongs here

The wiki starts empty on purpose. As the project grows, feed it: design decisions, Sitecore API quirks, package format details, incident post-mortems, onboarding notes, research. Anything you'd otherwise re-explain (to a person or to Claude) belongs here.
