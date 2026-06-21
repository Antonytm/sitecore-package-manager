# About This Wiki

This wiki is the project's compiled knowledge base, built on Karpathy's LLM Wiki pattern: instead of retrieving raw documents on every question (RAG-style), an LLM compiles sources into structured, interlinked articles once, and knowledge accumulates.

## How knowledge gets in

1. Drop anything worth keeping into `wiki/inbox/` — exported docs, pasted Slack/email threads, decision records, API research, post-mortems. Plain text, Markdown, or anything Claude can read.
2. Run `/wiki-compile` in Claude Code. It will:
   - read each inbox item,
   - update existing articles when the topic already exists (preferred), or create new ones,
   - add `[[wikilinks]]` between related articles,
   - update `INDEX.md`,
   - move processed sources to `wiki/sources/`.

## How knowledge gets out

Just ask Claude Code — it consults `INDEX.md` and follows links. For human browsing, open the `wiki/` folder as an Obsidian vault: wikilinks resolve and the graph view shows the structure.

## What belongs here vs elsewhere

| Knowledge | Where |
|-----------|-------|
| How to build/run the code, architecture, commands | `CLAUDE.md` / `README.md` |
| Why a decision was made, external API quirks, research, domain knowledge, lessons learned | **this wiki** |
| Secrets, credentials | nowhere in git — `.env` |

## Sources

- Seeded with the template; see `wiki/README.md` for full conventions.
