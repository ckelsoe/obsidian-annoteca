# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
