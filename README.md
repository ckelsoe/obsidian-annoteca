# Annoteca

[![CI](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-annoteca/ci.yml?branch=main&label=CI&logo=github)](https://github.com/ckelsoe/obsidian-annoteca/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-annoteca/release.yml?label=Release&logo=github)](https://github.com/ckelsoe/obsidian-annoteca/actions/workflows/release.yml) [![GitHub Downloads](https://img.shields.io/github/downloads/ckelsoe/obsidian-annoteca/total?logo=github&label=Downloads)](https://github.com/ckelsoe/obsidian-annoteca/releases) [![Obsidian](https://img.shields.io/badge/Obsidian-v1.13.0%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md) [![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ckelsoe/obsidian-annoteca/blob/main/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/ckelsoe/obsidian-annoteca?label=Latest)](https://github.com/ckelsoe/obsidian-annoteca/releases/latest)

Categorized inline feedback comments for long-form markdown documents. Comments live in the file as plain HTML markers, so they are readable by humans, by grep, and by any AI assistant. Works on desktop and mobile.

Requires Obsidian 1.13.0 or later.

Annoteca is built for revision work on long documents: book manuscripts, theses, technical docs, sermon and lecture prep. You leave typed feedback at the exact passage it concerns ("tighten this", "needs a source", "doesn't sound like me"), reply in threads, and resolve items as the draft improves. The comments travel with the file, survive without the plugin, and can be stripped cleanly at export time.

## Features

- **Categorized comments.** Every comment carries a category that says what kind of feedback it is. Seven defaults ship for general revision work (Tone, Clarify, Cut, Expand, Tighten, Source needed, Uncategorized); presets add sets for scholarly writing, fiction, code review, and project planning. Categories are fully editable, each with its own icon, color, and underline urgency tier, and you can save your own preset lists.
- **Anchored to the text.** Comment a selection and the commented words get a category-tinted underline in the editor. Comment at the cursor and a small marker icon shows the location. Underline style and thickness are configurable.
- **Threaded conversations.** Replies live inside the same marker, in order, each signed with an author tag and date. A conversation about a sentence stays attached to that sentence, even when the paragraph moves.
- **Comment hub.** A right-sidebar panel with three tabs: Thread (the conversation view), Outline (open and resolved counts per heading, click to jump), and Starred (bookmarked comments). The Thread tab scopes to the current file, a folder with or without subfolders, the whole vault, a frontmatter property value, or a tag, and the scope can be pinned.
- **Reading view indicators.** Markers are invisible in reading view by design, so Annoteca can show a note-level banner with open and resolved totals, a badge on each section that has comments, both, or nothing. Click an indicator to open the hub on that comment.
- **Resolve your way.** Resolving keeps the comment in the file as a dimmed record by default, and resolved comments can be reopened with one click. Prefer clean files? Use "Resolve and remove", turn on delete-on-resolve, or sweep a file with "Delete all resolved comments".
- **Hover popup.** Hover a marker to read the thread and reply, resolve, or jump to the hub without leaving the editor.
- **Import what you already have.** Commands convert Obsidian `%%comments%%` and plain HTML comments into Annoteca markers, with a backup confirmation first.
- **AI-ready by design.** The file is the API: any assistant that can read and edit markdown can read and write Annoteca comments. An "Export AI skill" command writes a skill file into your vault that teaches the assistant the format and your category vocabulary.

## How it works

A comment is an HTML comment with a typed prefix, placed at the text it concerns:

```markdown
The pricing model needs revisiting before Q3. <!-- annoteca/clarify: which products? -->
```

Threads, metadata, and resolution live inside the same marker:

```markdown
She knew what love felt like.
<!-- annoteca/tone: doesn't sound like me
[id=a3b9c2x7]
[date=2026-05-23]
[anchor=She knew what love felt like.]
[reply ai 2026-05-23]: Consider "She knew, in her bones, what love felt like."
[reply charles 2026-05-24]: I like "in her bones." Trying it.
[resolved charles 2026-05-25]: rewrote the line
-->
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
4. Resolve when addressed. Reopen if it comes back. Use "Resolve and remove" when you want the marker gone instead of kept as history.
5. Navigate with "Next comment" / "Previous comment", which follow your current scope across files.

Diagnostics commands cover the edge cases: find orphaned comments whose surrounding prose was deleted, detect markers that drifted, validate malformed markers, and back up or restore plugin settings.

## Working with AI assistants

Because comments are plain text in the file, an AI assistant needs no plugin API or special integration. Ask it to review a chapter and it can leave categorized comments at the passages it means. Ask it to address your comments and it can edit exactly the flagged passages and reply in each thread explaining the change, leaving the rest of the document untouched. Author tags (`author=ai`, `author=claude`) keep the conversation attributed.

To teach an assistant the format, run **Export AI skill**. It writes a skill file into the vault describing the marker grammar, the reply and resolve conventions, and the exact categories you have configured. The destination is a setting: `.claude/skills/` for Claude Code, a `.agent/skills/` folder for other assistants, or both.

## Settings overview

- **Categories**: edit the list, browse presets, set per-category icon, color, and underline tier.
- **Indicators**: marker icon and underline style, size, thickness, default visibility, resolved-comment display and brightness, reading view indicator, composer location.
- **Resolution**: delete-on-resolve toggle.
- **Metadata**: author tag for your comments.
- **AI integration**: skill export destination and button.
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

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, quality gates, and conventions.

## License

MIT. See [LICENSE](./LICENSE).
