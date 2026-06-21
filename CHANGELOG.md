# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.0] - 2026-06-21

### Changed
- Lowered the minimum Obsidian version from 1.13.0 to 1.8.7. The settings tab now supports both the declarative settings API (Obsidian 1.13.0+) and the classic imperative settings tab (older versions), following Obsidian's dual-support migration pattern. Users on Obsidian 1.8.7 through 1.12.x can now install and use the plugin. No change to behavior on 1.13.0+.

## [1.5.1] - 2026-06-21

### Changed
- README updated to document the features added across 1.1.0 to 1.5.0: the AI revision flow (addressed state, lossless originals, accept / revise / reject), the active-comment highlight and stable navigation, the per-reply author picker and per-author colors, and the exported-skill out-of-date indicator. Documentation only; no code changes.

## [1.5.0] - 2026-06-20

### Added
- Exported AI skill staleness detection (F-277). The exported `SKILL.md` now carries a schema version. When the guidance changes in a future update, the "Export AI skill" setting shows an "out of date" indicator and a one-time notice appears on load, so a previously exported skill does not silently teach an assistant the old rules. Re-exporting clears it. The schema version is bumped only when the teaching actually changes, not on every release.

## [1.4.0] - 2026-06-20

### Added
- Per-reply author picker (F-274). The reply composer (both the in-editor popup and the thread panel) now has an author dropdown so distinct collaborators each sign their own reply, instead of every reply using one global tag. Options come from the configured author tag, the collaborators you set up, and anyone already in the thread.
- Per-author styling (F-275). A new "Collaborators and author colors" setting lets you give each author tag a color; that color tints the author's name and replies in the hover popup and the thread panel, so a multi-party conversation is easy to scan.

## [1.3.0] - 2026-06-20

### Added
- Addressed state for the AI revision flow (F-270). A new `[addressed <author> <date>]: <note>` trailing line marks that an edit was applied in response to a comment and is awaiting your accept / revise / reject. It is a highlighted sub-state of open (orange ring on the marker, "addressed" badge in the hover), never hidden from review.
- Lossless originals (F-271). When an assistant replaces the commented passage, the verbatim old text is preserved in an `annoteca-original` fenced block inside the comment, shown as "original (replaced)" in the hover.
- Accept / revise / reject actions in the hover popup. Accept resolves the comment (honoring delete-on-resolve), revise returns it to open for further editing, and reject auto-reverts the prose from the stored original.
- The exported AI skill now teaches the address-by-replace flow with a worked example, and explicitly forbids deleting markers and resolving comments unprompted.

### Changed
- Convert-to-standalone on replace (F-272). An addressed comment whose anchor no longer matches the document is treated as the expected "replaced" state, not flagged as an orphan.

## [1.2.0] - 2026-06-20

### Added
- Direction-agnostic anchor underlines (F-273). The underline over commented text now resolves whether the marker sits before or after the passage, so anchors render on both new and existing comments.

### Changed
- New comments now place their marker at the beginning of the selected text (the prose the comment is about follows the marker). This reads warning-before-text, like `eslint-disable-next-line`. Existing comments whose marker trails the text keep working unchanged: no migration, and end-placement stays valid and supported.

## [1.1.0] - 2026-06-20

### Added
- Active-comment highlight (F-276): the comment whose thread is open in the side panel now gets a soft background over its anchored text and marker in the editor, so you never lose track of which comment you are reading.
- "Center comment when navigating" setting (off by default). When off, jumping to a comment scrolls the editor the minimum needed and does not move at all when the comment is already on screen.

### Changed
- Navigating to a comment no longer force-centers it. Opening the comment panel preserves your reading position: the editor's scroll is captured before the sidebar expands and restored after, so the document stays put.

## [1.0.4] - 2026-06-11

### Changed
- PRIVACY.md now names the vault file enumeration (scopes, diagnostics, bulk convert) and the clipboard write ("Copy ID", write-only) explicitly, per the developer-dashboard preview scan recommendations. No code changes.

## [1.0.3] - 2026-06-11

### Changed
- The worked example in the README and the exported AI skill now uses a business document (a forecast sentence) instead of fiction prose. The example still round-trips through the real parser in tests.

## [1.0.2] - 2026-06-11

### Added
- Settings tab footer with the plugin version, GitHub link, and Report Issues link, matching the convention used by the maintainer's other plugins.

### Changed
- Removed the version/repo footer from the exported AI skill file (added in 1.0.1); the settings footer is the right home for that information.

## [1.0.1] - 2026-06-11

### Fixed
- Marker clicks and hub-opening actions now actually open the right sidebar when it is collapsed. The hub leaf is pre-created at startup, and the old activation path only set it active, which does not expand a collapsed sidebar; the panel appeared to never open unless it had been opened manually. Activation now goes through `workspace.revealLeaf`, awaited, which also resolves the deferred view before comment-selection events are emitted at it.

### Changed
- The exported AI skill file now ends with a footer naming the generating plugin version and linking the repository, with a reminder to re-export after category changes or upgrades.

## [1.0.0] - 2026-06-11

First stable release, prepared for Obsidian community plugin submission. No code changes since 0.9.0.

### Changed
- README rewritten to document the full feature set: categories and presets, anchored underlines, threaded conversations, the comment hub, reading-view indicators, resolve workflows, imports, and the AI skill export. Minimum-Obsidian badge corrected to 1.13.0.
- PRIVACY.md data-flow section filled in (it previously carried a template placeholder).

## [0.9.0] - 2026-06-11

### Added
- "Resolve and remove" action: resolves a comment by deleting its marker from the file instead of keeping a [resolved ...] line. Available everywhere Resolve appears: Thread tab card, hover popup, editor right-click menu, and a new "Resolve and remove comment here" command. Always asks for confirmation (same modal as delete, with resolve wording).
- "Delete on resolve" setting (off by default). When enabled, plain Resolve removes the marker without asking; the toggle is the opt-in. Keep-in-place history remains the default behavior.

## [0.8.0] - 2026-06-11

### Added
- Reading-view comment indicator. Markers are HTML comments, which the reading-view renderer drops, so until now comments were completely invisible in reading view. A new "Reading view indicator" setting shows a note-level banner with the file's open/resolved totals (default), a badge on each section that contains comments, both, or nothing. Counts are threads; replies are not counted. Clicking an indicator opens the comment panel on that comment.

## [0.7.0] - 2026-06-11

### Added
- "Export AI skill" command and settings button. Writes a SKILL.md into the vault that teaches an AI assistant the marker grammar, the reply/resolve conventions, and this vault's configured categories. A new "Skill export destination" setting picks the folder: `.claude/skills/annoteca/` (Claude Code, the default), `.agent/skills/annoteca/` (other assistants), or both. The shipped example marker is covered by a test that parses it with the real parser, so the taught grammar cannot drift from the implementation.

## [0.6.0] - 2026-06-10

### Changed
- Internal restructuring, no behavior change:
  - The five vault-scanning diagnostics commands moved from the plugin class into a new `diagnostics-service.ts`; the three marker scans (conflicts, orphans, validation) now share one parameterized scan loop instead of three copies. `main.ts` drops from 1,044 to 943 lines.
  - The four sidebar views share an `AnnotecaBaseView` base class for plugin injection and close-time cleanup instead of copy-pasted constructors.
  - The two comment converters in `imports.ts` share one replacement engine.

### Fixed
- Long-running commands (diagnostics, drift check, bulk convert, settings backup/restore) now surface failures as a notice instead of dying silently into the developer console mid-scan.
- Settings restore logs the underlying parse error to the console alongside the "not valid JSON" notice, so a malformed backup can actually be debugged.
- The icon picker no longer leaves its deferred focus timer running when the modal is closed before the timer fires.

## [0.5.1] - 2026-06-10

### Changed
- tsconfig `lib` extended to ES2017/ES2018 to match the code and the esbuild target. Type-check-only; no runtime change in the built plugin.

## [0.5.0] - 2026-06-05

### Changed
- Author identifier is far less restrictive. Tags like `Charles`, `J.Doe`, or `AI-Bot` are stored and written into comment metadata as typed, instead of being forced to lowercase letters/digits/dashes. The only characters not allowed are the ones that would break the storage format: spaces (the field delimiter in reply and resolved lines), `]`, `<`, and `>`. The parser accepts these authors in `[author=...]`, `[reply ...]`, and `[resolved ...]` lines; existing tags are unaffected. The settings field placeholder is now a generic `reviewer`.

## [0.4.0] - 2026-06-05

### Changed
- Requires Obsidian 1.13.0 or later. Obsidian keeps serving 0.3.1 to vaults on older versions, so nothing breaks for them.
- Settings migrated to Obsidian's declarative settings API. The Indicators, Metadata, and Diagnostics options are now indexed in Obsidian's global settings search and grouped into labeled sections, and the author identifier and debug log destination rows now show or hide live as you toggle their parent option. The preset browser, category accordion, and add-category form keep their full-width custom controls. No setting changed its stored value or behavior.
- Replaced the deprecated `setWarning()` calls on the delete confirmation buttons with `setDestructive()` for the Obsidian 1.13.0 API.

## [0.3.1] - 2026-05-26

### Fixed
- **Hover popup closed the moment the mouse moved when hovering an anchor underline.** The anchor-underline hover predicate (added in 0.3.0) set the tooltip's source range to the marker icon's range even when the user was hovering the anchor underline. CodeMirror's keepalive then dismissed the tooltip on any mouse movement because the cursor was already "outside" the declared source range. Fix: the tooltip now reports whichever range the mouse is actually over (marker or anchor underline).
- **Resolve / reopen / delete / append-reply could be silently clobbered by the editor's autosave when the file was open.** `vault.modify` was racing the editor's in-memory document; if the editor had any state to flush, it would overwrite the new content and "restore" the marker the user had just acted on. Lifecycle writes now go through `editor.replaceRange` when the file is open in any markdown leaf (keeping the CodeMirror EditorState authoritative) and fall back to `vault.modify` only when the file is not open. This matches the pattern the edit composer was already using.

### Added
- **Confirmation prompt before single-comment delete.** Every entry point (Thread tab "Delete" button, editor right-click menu, command palette "Delete comment here") now shows a small modal with the comment's category badge and body excerpt before removing the marker. The bulk "Delete all resolved comments in this file" command has its own confirmation and is unchanged.

### Changed (internal — no behavior difference)
- `AnnotecaPanelView` extracted into a ~100-line dispatcher plus three focused renderer modules: `hub-thread-tab.ts`, `hub-outline-tab.ts`, `hub-starred-tab.ts`. The Thread tab's per-session state (collapse paths, active comment) lives with the Thread renderer rather than on the parent view.
- Long render methods inside the Thread renderer split into focused helpers: `buildScopedGroups`, `selectActiveComment`, `applyAutoCollapsePolicy`, `renderFileGroup`, `renderCompactRow`, `renderExpandedSection`.
- Comment lifecycle verbs (`resolveComment`, `reopenComment`, `deleteComment`, `appendReply`, `replaceMarker`, `listResolvedInFile`, `deleteAllResolvedInFile`, `resolvedAuthor`) moved into a new `CommentService` module. `AnnotecaPlugin` keeps thin pass-through methods so external callers do not change.

## [0.3.0] - 2026-05-26

This release bundles several distinct feature themes that landed on `main` before a release boundary was cut. Going forward, plugin releases will partition per feature theme; see the workspace `CLAUDE.md` "Release cadence" note.

### Added

#### Hub panel overhaul
- Replaced the three earlier sidebar views with a single right-sidebar hub (`Annoteca` view) containing Thread / Outline / Starred internal tabs.
- **Scope selector** on the Thread tab: This file, This folder (with and without subfolders), Vault, Property `key = value` (frontmatter-driven), Tag. Property and Tag option lists populate from the active file. Scope state persists across restarts; auto-collapses to "this file" when the active file moves outside the current scope and scope is unpinned.
- **Pin button** on the scope toolbar to lock scope to a specific path; pinned scope ignores file changes.
- **Multi-file scope rendering**: comments group by file with per-file header + count badge. Single-file scope renders without the per-file header since the panel header already implies the file.
- **Starred (bookmarked) comments** persisted in settings. Star toggle in three places: hover popup header, Thread tab card header, Starred tab card. Comments without an ID cannot be starred. Starred tab lists most-recently-starred first.
- **Reply drafts**: in-progress reply text persists to vault-local storage (not `data.json`, so it does not propagate via Obsidian Sync). Debounced on input, restored on composer open, cleared on send. Composer outside-click no longer dismisses a non-empty composer.
- **Outline tab interactions**: open/resolved count badges per heading are clickable — click navigates to the first matching comment in that section. Row containing the cursor is highlighted.
- Internal tab selection persists across restarts (`settings.lastHubTab`); marker clicks force the Thread tab.
- Next/previous comment commands respect scope and walk across files within scope.
- **Delete all resolved comments in this file** command (confirmation modal sized to count, single write, rebuild index).

#### Settings UX
- **Accordion category rows**: only the active category expands; others collapse to a single-line summary.
- **Leaner icon and color pickers**: the icon picker is now a stacked search-and-grid, the color picker shows theme-adaptive swatches with a custom-color chip beneath.
- **Browse presets**: cherry-pick categories from `general`, `scholarly`, `fiction`, `code-review`, and `project-planning` presets into the working list (additive, not destructive). User-saved presets persist in `settings.customPresets`.
- Removed the `enableScholarlyPreset` boolean toggle; its categories now live inside the `scholarly` preset.
- Long-form settings rows (textareas, multi-control rows) now use a stacked layout (label/description above, control below) rather than fighting Obsidian's narrow right-rail `Setting` widget.

#### Color picker (custom chip seeding)
- Native `<input type="color">` chip is silently seeded from the currently active theme swatch (resolved to hex via `getComputedStyle`), so opening the OS picker opens it on the theme color, ready to nudge into a variation.

#### Anchor underlines for commented text
- New marker syntax tail line `[anchor=<commented text>]` captures the text the comment was attached to at creation.
- Renders a category-tinted underline over the anchor range in the editor; clicking or hovering the underline triggers the same comment popup as the inline marker.
- Configurable indicator style includes a new `"underline"` option (in addition to `"icon"`, `"gutter"`, `"both"`, `"none"`).

#### Resolved-state polish
- Resolved comments always show an icon (no longer category-toggled).
- Resolved comments in scope lists render with strikethrough.
- New brightness toggle controls dimming of resolved entries.

### Fixed
- **Hide-all-comments was global with confused bookkeeping**: a per-view `__annotecaHidden` field was being written but never read; the decoration compute only consulted a module-level singleton. A toggle in pane B would silently affect pane A. Per-view writes have been removed; the toggle is now unambiguously global (one switch, all editors).
- **`rgbStringToHex` no longer silently returns `#000000` on malformed input**. Returns `undefined` instead, so callers can skip the assignment rather than seeding black on a `transparent` or `display:none` swatch.

### Changed
- Removed the `AnnotecaEvents` class wrapper around Obsidian's `Events`. Call sites now use `events.trigger(...)` directly.
- Type augmentations for the Obsidian API moved from `types.d.ts` (which was being shadowed by the runtime `types.ts`) to `globals.d.ts`. Added a proper `Editor.cm` augmentation that removes four `as unknown as` double-casts from `main.ts` and one from `decorations.ts`.
- `tsconfig.json` `include` now lists `**/*.d.ts` explicitly so ambient declaration files compile (TypeScript's `**/*.ts` glob does not match `.d.ts`).
- Pure helpers extracted for unit-testability:
  - `scope.ts` — scope-shape dispatch (`computeScopeFileSet`).
  - `view-utils.ts` — `extractIndexTerm`, `bucketCommentsByHeading`.
  - `rgbStringToHex` exported from `ui-helpers.ts`.
- New test suite `__tests__/helpers.test.ts` covers all four (30 new tests).

## [0.2.0] - 2026-05-26

First public release. Bundles the V1 foundation and the full V2 feature set.

### Added
- V2 features:
  - Threaded replies UI in the reviewer pane (F-021, F-066): reply input persists into the parent comment as a chronological `[reply ...]` line.
  - Outline density view (F-048) listing the active file's headings with open and resolved comment counts per heading.
  - Author tag toggle (F-075) wiring the optional `[author=...]` field into the modal and the resolution / reply paths.
  - Per-category icon customization (F-204) rendered in the sidebar group headers and reviewer pane category badge.
  - Per-category modal templates (F-212) for `verse-needed`, `source-needed`, and `index-entry`, composing structured field values into the comment body.
  - Import commands (F-221, F-222, F-230) for converting native `%%comments%%` and generic HTML comments to the canonical format, gated by a backup-confirmation modal.
  - Position drift detection (F-234) that snapshots surrounding-text signatures and reports drift on subsequent runs.
  - Settings backup and restore (F-236) writing to a JSON file in the vault.
  - Self-diagnostic command (F-237) writing a status summary to an in-vault note.
  - Scripture reference auto-formatting (F-251) command rewriting `john 3:16 esv` to `John 3:16 (ESV)` for the known 66-book canon and a list of common translations.
  - Index-entry category preset (F-260) plus a Pandoc Lua filter (`docs/pandoc-annoteca.lua`) that maps `index-entry` comments to LaTeX `\index{}` at export time.
- UX improvements after first live-test feedback:
  - The reviewer pane now lists every comment in the active file as collapsible cards; the active comment is expanded for reply and lifecycle actions, others are previews that promote on click.
  - Adding a new comment auto-opens the reviewer pane with that comment selected.
  - Optional "right side panel" composer location as an alternative to the modal dialog.
  - Ribbon icon for opening the reviewer pane, and an idempotent first-load placement of the pane in the right sidebar so its tab icon appears next to the native sidebar tabs.

### Fixed
- Marker text no longer leaks through in Live Preview. The decoration now replaces the raw `<!-- annoteca/...-->` with a small category-tinted glyph when the cursor is outside the marker; the raw text is restored when the cursor enters the marker so direct editing still works.
- Switched the file-navigation path off the deprecated `getLeaf(false)` API onto `getMostRecentLeaf()` with a tab-fallback, clearing the CI deprecated-API gate.

## [0.1.0] - 2026-05-25

### Added
- V1 plugin implementation:
  - Pure parser and serializer for the Annoteca marker format (`<!-- annoteca/<category>: <body> -->`), with metadata, threaded replies, and resolution lines round-tripping cleanly through `parse(serialize(c))`.
  - In-memory per-file comment index with vault-wide queries by file, category, and resolved state.
  - Default category set (tone, clarify, cut, expand, tighten, source-needed, uncategorized) and an optional scholarly preset (verse-needed, meditation).
  - Settings tab covering categories, indicator style, default visibility, resolved-comment display, author tag, and debug mode.
  - Add-comment modal with category dropdown, body input, and a scratchpad toggle.
  - CodeMirror 6 extension that decorates markers with category-tinted underlines, hover preview tooltips, and click-to-open-reviewer interactions.
  - Per-file sidebar grouped by category, a vault-wide unresolved comments view with path/category/resolved filters, and a reviewer pane with reply input and lifecycle actions (resolve, reopen, edit, delete, copy ID, navigate).
  - Comment lifecycle commands: add, edit, delete, resolve, reopen, reply, scratchpad capture.
  - Navigation commands: next, previous, next-unresolved, previous-unresolved, plus hide-all-comments and cycle-indicator-style.
  - Diagnostics commands: marker conflict detector, orphan comment detector, format validation.
  - Editor right-click menu integration mirroring the comment lifecycle actions.
- Initial release.
