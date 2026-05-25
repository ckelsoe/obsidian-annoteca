# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-25

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
