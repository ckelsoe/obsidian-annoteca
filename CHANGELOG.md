# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [0.1.0] - YYYY-MM-DD

### Added
- Initial release.
