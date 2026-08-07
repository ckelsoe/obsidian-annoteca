# Annoteca

[![CI](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-annoteca/ci.yml?branch=main&label=CI&logo=github)](https://github.com/ckelsoe/obsidian-annoteca/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-annoteca/release.yml?label=Release&logo=github)](https://github.com/ckelsoe/obsidian-annoteca/actions/workflows/release.yml) [![GitHub Downloads](https://img.shields.io/github/downloads/ckelsoe/obsidian-annoteca/total?logo=github&label=Downloads)](https://github.com/ckelsoe/obsidian-annoteca/releases) [![Obsidian](https://img.shields.io/badge/Obsidian-v1.13.0%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md) [![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ckelsoe/obsidian-annoteca/blob/main/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/ckelsoe/obsidian-annoteca?label=Latest)](https://github.com/ckelsoe/obsidian-annoteca/releases/latest)

Categorized inline feedback comments for long-form markdown documents. Comments live in the file as plain HTML markers, so they are readable by humans, by grep, and by any AI assistant. Works on desktop and mobile.

Requires Obsidian 1.13.0 or later.

Annoteca is built for revision work on long documents: book manuscripts, theses, technical docs, sermon and lecture prep. You leave typed feedback at the exact passage it concerns ("tighten this", "needs a source", "doesn't sound like me"), reply in threads, and resolve items as the draft improves. The comments travel with the file, survive without the plugin, and can be stripped cleanly at export time.

## Features

- **Categorized comments.** Every comment carries a category that says what kind of feedback it is. Seven defaults ship for general revision work (Tone, Clarify, Cut, Expand, Tighten, Source needed, Uncategorized); presets add sets for scholarly writing, fiction, code review, and project planning. Categories are fully editable, each with its own icon, color, and underline urgency tier, and you can save your own preset lists.
- **Anchored to the text.** Comment a selection and the commented words get a category-tinted underline in the editor; new markers sit at the start of the passage they concern. Comment at the cursor and a small marker icon shows the location. Underline style and thickness are configurable. Opening a comment highlights its passage in the editor, and jumping to a comment no longer yanks your reading position.
- **Threaded conversations.** Replies live inside the same marker, in order, each signed with an author tag and date. A per-reply author picker lets several collaborators each sign their own reply, and you can give each author a color so a multi-party thread is easy to scan. A conversation about a sentence stays attached to that sentence, even when the paragraph moves. A marker with replies shows how many, so a one-line note and a long back-and-forth are told apart at a glance.
- **AI revision flow.** When an assistant rewrites a passage in response to a comment, it marks the comment *addressed* and keeps the original text verbatim inside the marker. The comment stays in your queue with an accept, revise, or reject choice: accept resolves it, revise reopens it for more work, and reject restores the original prose automatically. You always see what changed and stay in control.
- **Comment hub.** A right-sidebar panel with three tabs: Thread (the conversation view), Outline (open and resolved counts per heading, click to jump), and Starred (bookmarked comments). The Thread tab scopes to the current file, a folder with or without subfolders, the whole vault, a frontmatter property value, or a tag, and the scope can be pinned.
- **Reading view indicators.** Markers are invisible in reading view by design, so Annoteca can show a note-level banner with open and resolved totals, a badge on each section that has comments, both, or nothing. Click an indicator to open the hub on that comment.
- **Resolve your way.** Resolving keeps the comment in the file as a dimmed record by default, and resolved comments can be reopened with one click. Prefer clean files? Use "Resolve and remove", turn on delete-on-resolve, or sweep a file with "Delete all resolved comments".
- **Hover popup.** Hover a marker to read the thread and reply, resolve, or jump to the hub without leaving the editor.
- **Comments read as Markdown.** Bodies, replies, and notes render as formatted Markdown in the popup and the hub, so links, emphasis, code, and lists look the way they were written rather than showing their source. `[[Wikilinks]]` resolve against the note the comment lives in. There is a setting to turn it off, and the one-line body shown beside a marker in the editor stays plain text either way so it cannot reflow the document.
- **Read the whole document's comments at once.** "Toggle inline comment bodies" prints each comment beside the passage it is about, so a chapter's feedback reads in a single pass instead of one hover at a time. Bodies are trimmed to a single line and disappear again on the next press.
- **Import what you already have.** Commands convert Obsidian `%%comments%%` and plain HTML comments into Annoteca markers, with a backup confirmation first.
- **AI-ready by design.** The file is the API: any assistant that can read and edit markdown can read and write Annoteca comments. An "Export AI skill" command writes a skill file into your vault that teaches the assistant the format and your category vocabulary. The exported skill is versioned, so the plugin tells you when it has gone out of date after an update and should be re-exported.

## How it works

A comment is an HTML comment with a typed prefix, placed at the text it concerns:

```markdown
The pricing model needs revisiting before Q3. <!-- annoteca/clarify: which products? -->
```

Threads, metadata, and resolution live inside the same marker:

```markdown
The Q3 forecast assumes a hiring freeze through December.
<!-- annoteca/tone: too blunt for the board deck
[id=a3b9c2x7]
[date=2026-05-23]
[anchor=assumes a hiring freeze through December]
[reply ai 2026-05-23]: Consider "reflects current headcount planning through December."
[reply charles 2026-05-24]: Better. Softening it.
[resolved charles 2026-05-25]: reworded the assumption
-->
```

When an assistant addresses a comment by rewriting the passage, it records the change on an `[addressed ...]` line and keeps the original text verbatim in a fenced block inside the marker, so a Reject can restore it:

```markdown
<!-- annoteca/clarify: hedging
[id=6raa4103]
[anchor=it landed as a shock]
[addressed claude 2026-06-20]: removed the hedging; original preserved inside the marker
-->
The discovery reframed the passage entirely.
```

Why HTML comments?

- **Nothing breaks without the plugin.** The file stays a normal markdown document. Markers never render in reading view or exports, and other tools pass them through untouched.
- **Standard tools work.** `grep -rn 'annoteca/'` finds every comment in a vault. `annoteca/tone` finds every tone comment.
- **Position is free.** The marker is part of the text, so cut, paste, and reorder operations move the comment with its paragraph. No coordinates to repair.
- **Clean publishing.** A Pandoc Lua filter (in the repository's `docs/` folder) strips markers at export time and converts index-entry comments into LaTeX `\index{}` commands.

## The review workflow

1. Select a passage and run **Add comment for selection** (or **Add comment here** at a bare cursor) from the command palette or the right-click menu.
2. Pick a category, write the feedback. The composer opens as a modal or as a side panel, your choice.
3. Reply from the hover popup, the hub's Thread tab, or by typing a `[reply ...]` line directly in the file.
4. When an assistant has addressed a comment, the hover popup offers **Accept**, **Revise**, or **Reject** (reject restores the original text). Otherwise resolve when done and reopen if it comes back, or use "Resolve and remove" to drop the marker instead of keeping it as history.
5. Navigate with "Next comment" / "Previous comment", which follow your current scope across files. The active comment is highlighted in the editor, and opening the panel keeps your place in the document.

Diagnostics commands cover the edge cases: find orphaned comments whose surrounding prose was deleted, clear orphaned stars whose comment no longer exists anywhere in the vault, detect markers that drifted, validate malformed markers, and back up or restore plugin settings.

Annoteca also warns you when a note has a broken comment marker, once per note as you open or save it. A marker that lost its closing tag hides the text after it without anything looking wrong, so the check runs on its own rather than waiting for you to go looking for it, and the notice says how to repair the marker.

## Working with AI assistants

Because comments are plain text in the file, an AI assistant needs no plugin API or special integration. Ask it to review a chapter and it can leave categorized comments at the passages it means. Ask it to address your comments and it can edit exactly the flagged passages and reply in each thread explaining the change, leaving the rest of the document untouched. When the fix is a rewrite, the assistant marks the comment addressed and keeps the original text inside the marker, so you can accept, revise, or reject the change from the hover popup. Author tags (`author=ai`, `author=claude`) keep the conversation attributed.

To teach an assistant the format, run **Export AI skill**. It writes a skill file into the vault describing the marker grammar, the reply, address, and resolve conventions, and the exact categories you have configured. The exported skill instructs the assistant never to delete markers or resolve comments unprompted, so your review queue is never quietly cleared. The destination is a setting: `.claude/skills/` for Claude Code, a `.agent/skills/` folder for other assistants, or both. The skill is versioned; when an update changes the guidance, the plugin flags the exported file as out of date so you can re-export.

## Settings overview

- **Categories**: edit the list, browse presets, set per-category icon, color, and underline tier.
- **Indicators**: marker icon and underline style, size, thickness, default visibility, reply count on markers, whether comments render as Markdown, resolved-comment display and brightness, reading view indicator, composer location, and whether jumping to a comment centers it or scrolls the minimum needed.
- **Resolution**: delete-on-resolve toggle.
- **Metadata**: author tag for your comments, plus collaborators and their colors for multi-party threads.
- **AI integration**: skill export destination, export button, and an out-of-date indicator.
- **Diagnostics**: debug logging.

## Installation

Annoteca requires Obsidian 1.13.0 or later. Obsidian offers the matching plugin version automatically; on older Obsidian versions the plugin will not appear as updatable beyond the last compatible release.

### From Obsidian community plugins (recommended)

1. Open Obsidian settings.
2. Navigate to **Community plugins**.
3. Click **Browse**.
4. Search for **Annoteca**.
5. Click **Install**, then **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ckelsoe/obsidian-annoteca/releases/latest).
2. Create a folder named `annoteca` in your vault's `.obsidian/plugins/` directory.
3. Copy the downloaded files into this folder.
4. Reload Obsidian.
5. Enable **Annoteca** in Settings → Community plugins.

### BRAT (optional, for pre-release testing)

BRAT lets power users install pre-release builds before they reach the marketplace.

1. Install the **BRAT** plugin from Community Plugins.
2. Open BRAT settings and click **Add Beta Plugin**.
3. Enter: `https://github.com/ckelsoe/obsidian-annoteca`
4. Enable **Annoteca** in Settings → Community plugins.

## Privacy

Annoteca reads and writes only your vault. No network requests, no telemetry, no data leaves your machine. See [PRIVACY.md](./PRIVACY.md).

## Community

Questions, ideas, and general discussion happen on [Discord](https://discord.gg/gd6tKJDPj4). For anything that needs tracking, a [GitHub issue](https://github.com/ckelsoe/obsidian-annoteca/issues) is still the better home.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, quality gates, and conventions.

## License

MIT. See [LICENSE](./LICENSE).
