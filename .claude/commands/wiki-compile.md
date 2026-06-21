# Wiki Compile

Compile raw sources from `wiki/inbox/` into the knowledge wiki (`wiki/articles/`), following the conventions in `wiki/README.md`.

If arguments are given ($ARGUMENTS), treat them as an additional source: a URL to fetch, a file path to read, or a topic described inline — compile it the same way as inbox items.

## Instructions

1. Read `wiki/INDEX.md` to load the current state of the wiki.
2. List `wiki/inbox/` — every file except `README.md` is an unprocessed source. If the inbox is empty and no arguments were given, say so and stop.
3. For each source, one at a time:
   - Read it fully.
   - Decide the target article(s): **prefer updating an existing article** over creating a near-duplicate. Check `INDEX.md` and grep `wiki/articles/` for overlapping topics before creating a new one.
   - Write the article in `wiki/articles/<kebab-case-slug>.md`:
     - Start with an `# H1 Title`.
     - Distill, don't transcribe — organized summary, key facts, decisions, caveats. Drop filler.
     - Cross-link related articles with `[[slug]]` wikilinks. Link liberally; a link to a not-yet-written article is fine (it marks a gap, not an error).
     - End with a `## Sources` section listing the origin (filename in `wiki/sources/`, or URL) with date. When updating an article, append the new source to the list.
   - Move the processed file from `wiki/inbox/` to `wiki/sources/` (keep the original filename; prefix with `YYYY-MM-DD-` if not already dated).
4. Update `wiki/INDEX.md`: one line per article — `- [[slug]] — one-line summary` — under an appropriate topic group. Add or rename groups as needed; keep the index complete and in sync with `wiki/articles/`.
5. Report: articles created, articles updated, sources archived, and any `[[links]]` pointing to articles that don't exist yet (suggested future articles).

## Rules

- Never edit files in `wiki/sources/` — they are the immutable raw record.
- Never delete an article without being explicitly asked; merge instead.
- Articles must be self-contained and readable without the source material.
