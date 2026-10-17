# Annoteca

[![CI](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-annoteca/ci.yml?branch=main&label=CI&logo=github)](https://github.com/ckelsoe/obsidian-annoteca/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-annoteca/release.yml?label=Release&logo=github)](https://github.com/ckelsoe/obsidian-annoteca/actions/workflows/release.yml) [![GitHub Downloads](https://img.shields.io/github/downloads/ckelsoe/obsidian-annoteca/total?logo=github&label=Downloads)](https://github.com/ckelsoe/obsidian-annoteca/releases) [![Obsidian](https://img.shields.io/badge/Obsidian-v1.13.0%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md) [![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ckelsoe/obsidian-annoteca/blob/main/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/ckelsoe/obsidian-annoteca?label=Latest)](https://github.com/ckelsoe/obsidian-annoteca/releases/latest)

Categorized inline feedback comments for long-form markdown documents. Comments live in the file as plain HTML markers, so they are readable by humans, by grep, and by any AI assistant. Works on desktop and mobile.

Requires Obsidian 1.13.0 or later.

Annoteca is built for revision work on long documents: book manuscripts, theses, technical docs, sermon and lecture prep. You leave typed feedback at the exact passage it concerns ("tighten this", "needs a source", "doesn't sound like me"), reply in threads, and resolve items as the draft improves. The comments travel with the file, survive without the plugin, and can be stripped cleanly at export time.

## Features

- **Categorized comments**: every comment carries a category that says what kind of feedback it is. Eight defaults ship for general revision work (Tone, Clarify, Cut, Expand, Tighten, Source needed, Note to self, Uncategorized); presets add sets for scholarly writing, fiction, code review, and project planning. Categories are fully editable, each with its own icon, color, underline urgency tier, optional default text and agent handling, and you can save your own preset lists. A category's default text is saved when you insert a comment with the body left empty, so a Cut can simply say "Remove this."
- **Anchored to the text**: comment a selection and the commented words get a category-tinted underline in the editor; new markers sit at the start of the passage they concern, and a closing marker after it records exactly where it ends. Comment at the cursor and a small marker icon shows the location. Underline style and thickness are configurable. Opening a comment highlights its passage in the editor, and jumping to a comment keeps your reading position. A jump briefly flashes the passage it lands on. In the hub, clicking a comment's text, or an addressed comment's original text, jumps to it in the note.
- **Threaded conversations**: replies live inside the same marker, in order, each signed with an author tag and date. A per-reply author picker lets several collaborators each sign their own reply, and you can give each author a color so a multi-party thread is easy to scan. A conversation about a sentence stays attached to that sentence, even when the paragraph moves. A marker with replies shows how many, so a one-line note and a long back-and-forth are told apart at a glance.
- **AI revision flow**: when an assistant rewrites a passage in response to a comment, it marks the comment *addressed* and keeps the original text verbatim inside the marker. The comment stays in your queue with an accept, revise, or reject choice: accept resolves it, revise reopens it for more work, and reject restores the original prose automatically. You always see what changed and stay in control.
- **Comment hub**: a right-sidebar panel with three tabs: Thread (the conversation view), Outline (a tree of the note's headings and, optionally, its list items, with comment counts rolled up per heading; click to jump, or comment on a line), and Starred (bookmarked comments). A fourth tab, Findings, appears when Plumbline is installed. The Thread tab scopes to the current file, a folder with or without subfolders, the whole vault, a frontmatter property value, or a tag, and the scope can be pinned. Focus on one comment to see only its conversation until you choose Show all, or open it in a tab of its own. A comment opened from a pop-out window opens in a tab beside its note in that window ("Open beside note").
- **Reading view indicators**: markers are invisible in reading view by design, so Annoteca can show a note-level banner with open and resolved totals, a badge on each section that has comments, both, or nothing. Click an indicator to open the hub on that comment.
- **Comment from reading view**: select text while reading, right-click and choose "Annoteca: add comment for selection" (or use the command), and the comment form opens on that passage without leaving reading view.
- **Resolve your way**: resolving keeps the comment in the file as a dimmed record by default, and resolved comments can be reopened with one click. Prefer clean files? Use "Resolve and remove", turn on delete-on-resolve, or sweep a file with "Delete all resolved comments in this file".
- **Two ways to store comments**: inline keeps the whole comment in its marker, right at the passage. End-of-file storage shrinks the marker to a short category-and-id tag and keeps the body, replies and history in a block at the bottom of the note, so the prose stays readable. A setting picks the default for new comments, an `annoteca_storage: inline` or `annoteca_storage: eof` property overrides it for one note, and commands convert one note or the whole vault either way.
- **Reply alerts (optional)**: get a popup and a sound when someone else comments or replies, for example an AI agent answering your comments while you work in another app. The popup can be an Obsidian notice you click to open the comment, a system notification, or both. The sound can be your computer's notification sound, an audio file from your vault, or a built-in tone. Several replies close together arrive as one alert. Your own comments never alert. Off by default.
- **Comments stay put**: typing or deleting around a comment keeps it, and if another tool (an AI agent, a formatter, a sync) rewrites a note and drops a comment, Annoteca offers to restore it. A comment whose text has moved can be sent back to it with **Find its text**.
- **Hover popup**: hover a marker to read the thread and reply, resolve, or jump to the hub without leaving the editor.
- **Comments read as Markdown**: bodies, replies, and notes render as formatted Markdown in the popup and the hub, so links, emphasis, code, and lists look the way they were written rather than showing their source. `[[Wikilinks]]` resolve against the note the comment lives in. There is a setting to turn it off, and the one-line body shown beside a marker in the editor stays plain text either way so it cannot reflow the document.
- **Read the whole document's comments at once**: "Toggle inline comment bodies" prints each comment beside the passage it is about, so a chapter's feedback reads in a single pass instead of one hover at a time. Bodies are trimmed to a single line and disappear again on the next press.
- **Quick capture and overview views**: "Add scratchpad comment" opens the comment form with Uncategorized already chosen, for a thought you will sort later. "Open unresolved comments view" lists every open comment in the vault, and "Open index entries view" lists your index-entry comments.
- **Import what you already have**: commands convert Obsidian `%%comments%%` and plain HTML comments into Annoteca markers, with a backup confirmation first.
- **Agent handling**: choose per category whether an AI agent acts on a comment, only replies, or leaves it for you. Note to self ships set to Skip, so a reminder you leave for yourself is not treated as a request. The choice is written into the exported AI skill, so export it again after a change.
- **AI-ready by design**: the file is the API: any assistant that can read and edit markdown can read and write Annoteca comments. An "Export AI skill" command writes a skill file into your vault that teaches the assistant the format and your category vocabulary. The exported skill is versioned, so the plugin tells you when it has gone out of date after an update and should be re-exported.
- **Bases-ready summary (optional)**: turn on a setting and Annoteca keeps a small summary of each note's review state in the note's frontmatter: the number of open comments, and optionally the oldest open date and the categories in play. An Obsidian Base can then filter and sort your notes by review status, for example every note with open comments across a project, as a work queue. Off by default; the comments stay in the note and your existing frontmatter is preserved.

## How it works

A comment is an HTML comment with a typed prefix, placed at the text it concerns:

```markdown
The pricing model needs revisiting before Q3. <!-- annoteca/clarify: which products? -->
```

With the default inline storage, threads, metadata, and resolution live inside the same marker:

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

A comment on a selection also marks where the selection ends, with a closing marker that carries the comment's id. The comment then covers exactly that text, however long, across lines and paragraphs:

```markdown
<!-- annoteca/tighten: wordy
[id=a3b9c2x7]
[range=closed]
--> The Q3 forecast assumes a hiring freeze through December.<!-- /annoteca a3b9c2x7 -->
```

With end-of-file storage the marker in the text is a short tag, and the rest of the comment sits in a store block at the bottom of the note:

```markdown
- <!-- annoteca/tighten: [id=a3b9c2x7] --> The Q3 forecast assumes a hiring freeze.<!-- /annoteca a3b9c2x7 -->

<!-- annoteca:store
{
  "v": 1,
  "id": "a3b9c2x7",
  "category": "tighten",
  "body": "wordy",
  ...
}
-->
```

The underline and highlight cover exactly that passage, and Reject restores exactly that passage. The `[range=closed]` line records that the comment was made with a closing marker, so if an edit later drops the closing marker, the orphan check reports it. A comment made at the cursor, and every comment from an earlier version, marks only where its passage starts, and works as it always has. A selection that starts or ends inside a code block, inline code, or the note properties gets no closing marker, since HTML would show there.

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

1. Select a passage and run **Add comment for selection** (or **Add comment here** at a bare cursor) from the command palette or the right-click menu. To comment on one sentence, click inside it and run **Add comment for current sentence**: Annoteca selects the sentence for you.
2. Pick a category, write the feedback. The composer opens as a modal or as a side panel, your choice.
3. Reply from the hover popup, the hub's Thread tab, or by typing a `[reply ...]` line directly in the file.
4. When an assistant has addressed a comment, the hover popup offers **Accept**, **Revise**, or **Reject** (reject restores the original text). Otherwise resolve when done and reopen if it comes back, or use "Resolve and remove" to drop the marker instead of keeping it as history.
5. Navigate with "Next comment" / "Previous comment", which follow your current scope across files. The active comment is highlighted in the editor, and opening the panel keeps your place in the document.

Diagnostics commands cover the edge cases: find orphaned comments whose surrounding prose was deleted, clear orphaned stars whose comment no longer exists anywhere in the vault, detect markers that drifted, validate malformed markers, and back up or restore plugin settings.

Annoteca also warns you when a note has a broken comment marker, once per note as you open or save it. A marker that lost its closing tag hides the text after it without anything looking wrong, so the check runs on its own rather than waiting for you to go looking for it, and the notice says how to repair the marker.

## Working with AI assistants

Because comments are plain text in the file, an AI assistant needs no plugin API or special integration. Ask it to review a chapter and it can leave categorized comments at the passages it means. Ask it to address your comments and it can edit exactly the flagged passages and reply in each thread explaining the change, leaving the rest of the document untouched. When the fix is a rewrite, the assistant marks the comment addressed and keeps the original text inside the marker, so you can accept, revise, or reject the change from the hover popup. Author tags (`author=ai`, `author=claude`) keep the conversation attributed.

To teach an assistant the format, run **Export AI skill**. It writes a skill file into the vault describing the marker grammar, the reply, address, and resolve conventions, the exact categories you have configured with each one's agent handling, and how to find every note with open comments from the frontmatter summary. The exported skill instructs the assistant never to delete markers or resolve comments unprompted, so your review queue is never quietly cleared. The destination is a setting: `.claude/skills/` for Claude Code, a `.agent/skills/` folder for other assistants, or both. The skill is versioned; when an update changes the guidance, the plugin flags the exported file as out of date so you can re-export.

## Public API

Annoteca has a public, versioned API for other plugins. A companion plugin can attach comments and AI-readable notes to a place in a document without building its own comment store: detect a comment marker with no dependency at all, read your comments, then create and jump to them through the API, and follow what happens to each comment as it happens. There is no hard dependency in either direction, and Annoteca stays the only writer of note markers. A companion can also offer the reader Resolve and Reopen on a comment, which run exactly as they do in the hub. Full guide and copyable types: [API.md](./API.md).

## Works with

- [Plumbline](https://github.com/ckelsoe/obsidian-plumbline) flags prose that reads as machine-written. With both installed, its findings show in the hub's Findings tab, and a finding can be promoted to an Annoteca comment.
- [Annoteca MindMap Bridge](https://github.com/ckelsoe/obsidian-annoteca-mindmap-bridge) puts your comments on the Mind map editor plugin's maps: a badge on each node with comments, and a "+" to comment on a node.

## Settings overview

Settings are grouped in the order they appear in the tab:

- **Categories**: edit the category list, browse and save presets, and set each category's icon, color, underline tier, default text and agent handling (act on it, reply only, or skip). Pick the default category, and turn on the index-entry preset for print indexing.
- **Comment storage**: where new comments keep their body, replies and history: inline in the marker, or at the end of the note.
- **Editor indicators**: how comments look in the editor. Indicator style (icon, underline, both, or hidden) and size; the hover preview and its delay; what a click or tap does (open the side panel or a popover); whether bodies render as Markdown; the reply count on markers; underline style and thickness; and whether comments show when a file opens.
- **Resolved comments**: whether resolved comments are dimmed or hidden, how strongly they dim, and whether resolving deletes the marker instead of keeping it as history.
- **Composer**: where the comment form opens (modal or side panel), whether Enter sends or adds a line break, whether the panel opens after each comment you send, and the floating comment button on selected text.
- **Reading view**: the indicator that stands in for comments where markers are invisible: a note banner, per-section badges, both, or off.
- **Panel and navigation**: whether the hub collapses files you are not editing, and where a marker lands when you jump to a comment (top, center, or minimal scroll).
- **Authors**: your author tag, plus collaborators each with a color so a multi-party thread is easy to scan.
- **Reply alerts**: the popup (off, in Obsidian, system notification, or both) and the sound (none, the system notification sound, a vault audio file, or a built-in tone) for comments and replies from anyone but you, with volume, a sound preview and a test alert. Off by default. Turning alerts on indexes the whole vault once each session.
- **AI integration**: where the exported skill file is written, the export button, the out-of-date indicator that appears after an update changes the guidance, how many comments another plugin may add at once before you are asked (default 10), and the optional event journal, a file a tool outside Obsidian can watch to follow comment changes (off by default; ids and metadata only, never comment text).
- **Frontmatter summary (Bases)**: maintain a Bases-friendly summary of each note's open comments in its frontmatter, choose whether to include the oldest-open date and the open categories, and an optional class tag (off by default, mainly for Fileclass or Metadata Menu users) with its property name.
- **Diagnostics**: debug logging and where the log is written, and the known comment namespaces: other tools' comment prefixes (such as `plumbline`) that the marker-conflict check should not report.

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

## Changelog

What changed in each version is in the [changelog](https://github.com/ckelsoe/obsidian-annoteca/blob/main/CHANGELOG.md). Each [release](https://github.com/ckelsoe/obsidian-annoteca/releases) also carries its own notes.

## Community

Questions, ideas, and general discussion happen on [Discord](https://discord.gg/gd6tKJDPj4). For anything that needs tracking, a [GitHub issue](https://github.com/ckelsoe/obsidian-annoteca/issues) is still the better home.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, quality gates, and conventions.

## License

MIT. See [LICENSE](./LICENSE).
