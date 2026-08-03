# Copilot cloud agent instructions for obsidian-annoteca

## What this repository is

Annoteca is an [Obsidian](https://obsidian.md) community plugin (TypeScript, Node 22, esbuild bundle). It adds categorized inline feedback comments to markdown documents. Comments are stored as plain HTML comments directly in the `.md` file so they survive without the plugin and are readable by any tool.

The plugin is listed in the Obsidian community marketplace and must comply with [Obsidian's plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).

---

## Repository layout

All TypeScript source files are in the **root** of the repository (not in a `src/` folder).

| Path | Role |
|---|---|
| `main.ts` | Plugin entry point — `AnnotecaPlugin extends Plugin` |
| `types.ts` | All shared TypeScript types; **no Obsidian import** |
| `parser.ts` | Marker format parser and serializer; **no Obsidian import** |
| `categories.ts` | Category catalog, validation, built-in presets; **no Obsidian import** |
| `settings.ts` | `AnnotecaSettings` defaults + settings tab |
| `comment-service.ts` | Comment lifecycle (resolve, reopen, delete, reply, replace) |
| `decorations.ts` | CodeMirror 6 editor extension (underlines, icons, hover popup) |
| `views.ts` | All `ItemView` subclasses (hub, composer panel, index-entry, vault-unresolved) |
| `hub-thread-tab.ts` / `hub-outline-tab.ts` / `hub-starred-tab.ts` | The three tabs inside the hub panel |
| `composer.ts` | Comment composer logic |
| `modal.ts` | `AddCommentModal` for the floating modal composer |
| `confirm-modal.ts` | Confirmation dialogs |
| `scope.ts` | Computes the set of files for a given Thread-tab scope |
| `index.ts` | `CommentIndex` — in-memory vault-wide comment index |
| `drift.ts` | Position-drift detection helpers |
| `diagnostics.ts` / `diagnostics-service.ts` | Diagnostic commands |
| `reading-view.ts` | Reading-view comment indicators (banner + per-section badges) |
| `imports.ts` | Converts Obsidian `%%comments%%` and plain HTML comments to Annoteca markers |
| `skill-export.ts` | Builds the AI skill SKILL.md; **no Obsidian import** |
| `scripture.ts` | Scripture reference formatting |
| `templates.ts` | Template helpers |
| `ui-helpers.ts` / `view-utils.ts` | Shared UI utilities |
| `platform.ts` | The only place that reads Obsidian's `Platform`; per-platform decisions go through it |
| `globals.d.ts` | Obsidian API type augmentations (`editor.cm`, `manifest.version`) |
| `styles.css` | All plugin CSS |
| `__tests__/` | Jest unit tests |
| `__mocks__/obsidian.ts` | Minimal Obsidian stub for Jest (no real plugin host) |
| `scripts/check-submission.mjs` | Obsidian marketplace submission pre-check (runs as part of lint) |
| `docs/pandoc-annoteca.lua` | Pandoc Lua filter that strips markers at export time |
| `esbuild.config.mjs` | esbuild config; dev build auto-copies artifacts into a sibling `obs-test-vault` if it exists |
| `version-bump.mjs` | Bumps version in `manifest.json` and `versions.json` |

---

## Build, lint, and test commands

```bash
npm install          # install all dependencies
npm run dev          # dev build with file watching (auto-copies to obs-test-vault if present)
npm run build        # TypeScript type-check (noEmit) + esbuild production bundle → main.js
npm run lint         # ESLint (zero warnings allowed) + prettier --check "**/*.ts" + scripts/check-submission.mjs
npm test             # Jest unit tests
```

All three gates (`lint`, `build`, `test`) must pass before opening a pull request. CI runs them in order on every push/PR to `main`.

---

## The marker format (the core data contract)

`parser.ts` is the **single source of truth** for the format. Do not invent or assume format details — read `parser.ts`.

### Simple marker (no metadata)

```markdown
The pricing model needs revisiting. <!-- annoteca/clarify: which products? -->
```

### Multi-line marker (with metadata)

```markdown
<!-- annoteca/tone: too blunt for the board deck
[id=a3b9c2x7]
[date=2026-05-23T14:32:10]
[author=charles]
[anchor=too blunt for the board deck]
[reply ai 2026-05-23T15:01:00]: Consider "reflects current headcount planning."
[reply charles 2026-05-24T09:12:45]: Better. Softening it.
[resolved charles 2026-05-25T10:00:00]: reworded the assumption
-->
```

### Addressed state (AI revision flow)

When an assistant rewrites a passage in response to a comment, it records an `[addressed ...]` line. If the prose was replaced, the original text is preserved verbatim in an `annoteca-original` fence so the user can reject and restore it:

```markdown
<!-- annoteca/clarify: hedging
[id=6raa4103]
[anchor=it landed as a shock]
[addressed claude 2026-06-20T11:30:00]: removed the hedging; original preserved inside the marker
```annoteca-original
it landed as a shock to the whole team
```
-->
```

### Format rules

- Category name: lowercase ASCII letters, digits, dashes; must start with a letter; no trailing dash; no consecutive dashes. Matches `/^[a-z](-?[a-z0-9])*$/`.
- Reserved category names (used as structural keywords): `reply`, `resolved`, `id`, `date`, `author`.
- Timestamps: `YYYY-MM-DDTHH:MM:SS` (no timezone). Legacy date-only `YYYY-MM-DD` still parses but new writes use the full timestamp.
- ID: 8-character lowercase base36 string.
- Anchor text: up to 80 visible characters; mid-truncated with `…` when longer.
- Replies are sorted chronologically by timestamp on read; file order is the tiebreak for equal timestamps.
- The `-->` sequence must never appear inside an `annoteca-original` fence (it would close the HTML comment wrapper).
- Forward-compatibility: unrecognized bracket-shaped trailing lines (`[unknown ...]`) are silently ignored by the parser.

---

## Coding conventions

These are enforced by CI and the Obsidian marketplace review — violating them will fail the build or block a release.

### TypeScript

- **TypeScript strict mode is on.** Never use `as any`. If the Obsidian types are missing, add a proper declaration to `globals.d.ts`.
- `types.ts`, `parser.ts`, `categories.ts`, and `skill-export.ts` have **no Obsidian import** and must stay that way. They are unit-tested under Node without the Obsidian host.
- Do not import Node built-ins (`path`, `fs`, etc.) at the top of `main.ts`. Wrap them in a `require()` guarded by `canRequireNode()` from `platform.ts`. **Not `Platform.isDesktop`**: that flag only means the UI is in desktop mode and can be true where Node does not exist, so guarding on it crashes the plugin at load in the exact environment the guard was for. `canRequireNode()` reads `Platform.isDesktopApp`, the Electron-runtime flag.

### Obsidian API

- Prefer `containerEl.createDiv()` / `containerEl.createSpan()` over the generic `createEl('div')` / `createEl('span')`.
- Use `getActiveViewOfType()` (not the deprecated `workspace.activeLeaf`).
- Use `MarkdownRenderer.render()` (not the deprecated `renderMarkdown()`).
- Use `getLeaf('tab')` / `getLeaf('split')` (not `getLeaf(true)` / `getLeaf(false)`).
- Use `Notice.messageEl` (not the deprecated `Notice.noticeEl`).
- Editor-aware writes: when a file is open in a markdown leaf, mutate through `editor.transaction(...)` rather than `vault.modify(...)`. `vault.modify` on an open file can be clobbered by the editor's autosave flushing its stale in-memory document back to disk.

### CSS

- No inline `style` attributes anywhere. All styles go in `styles.css`.
- No `!important` in `styles.css`. Raise selector specificity instead.

### ESLint

- Zero warnings are allowed (`--max-warnings 0`).
- **Never** add an `eslint-disable` for any `obsidianmd/*` rule. The Obsidian developer-dashboard preview scan rejects suppressed rules; comply with the rule instead (rename or restructure).
- Every `eslint-disable` / `eslint-enable` directive comment that is allowed must include a `-- description` explaining why (e.g., `// eslint-disable-next-line some-rule -- reason here`).

### UI strings

- All UI strings (commands, menu items, setting names, notifications) use **sentence case**.
- Exception: brand names recognized by `eslint-plugin-obsidianmd` (Markdown, macOS, iOS, Windows, Linux, etc.) keep their official casing.

### Mobile compatibility

`isDesktopOnly` is `false` in `manifest.json`. Every feature must degrade gracefully on iOS and Android. Pointer-only affordances (drag handles, right-click menus) are fine as long as the core workflow remains accessible without them.

Two seams exist for this, and they are not interchangeable:

- **`styles.css` `@media` queries** for anything about available width. Prefer these over a `Platform` check, which is usually the wrong tool for a layout problem. But be precise about what `@media` measures: **the viewport, not the element.** That makes it correct for the settings modal, which is full-screen on a phone and wide on a desktop, so viewport width and available width agree. It is *incorrect* for anything rendered inside a sidebar leaf (the Hub panel), because the user drags that width independently of the window — a viewport breakpoint will simply never fire at the right moment there. Use a container query for leaf content.
- **`platform.ts`** for decisions that genuinely differ by input method or runtime, not by size. It is the single point of contact with Obsidian's `Platform`; do not import `Platform` directly elsewhere, including for the Node `require()` guard. Its functions read the object per call rather than caching a boolean at module load, because a tablet can be re-docked. Its helpers are named after the capability they gate (`supportsDragAndDrop`, `canRequireNode`) rather than after a platform, because `Platform` exposes near-identical flags that mean different things — `isDesktop` is UI mode, `isDesktopApp` is the Electron runtime — and a capability name makes picking the wrong one much harder.

Worked example: category reordering. Move up / move down buttons render everywhere, because drag-and-drop is unusable by keyboard as well as by touch. The drag handle is rendered only when `supportsDragAndDrop()` is true, so touch users do not get a grip that silently does nothing. Reordering logic itself stays in `categories.ts` as a pure function, so both routes share one implementation.

### Settings UI headings

Settings tab section headings must not contain the words "settings", "options", "general", or the plugin name ("Annoteca").

---

## Adding or editing tests

- Tests live in `__tests__/` and are named `*.test.ts`.
- The Jest environment is `node`. Obsidian APIs are stubbed by `__mocks__/obsidian.ts`.
- Pure modules (`parser.ts`, `categories.ts`, `types.ts`, `skill-export.ts`, etc.) can be tested directly. Modules that import `obsidian` work via the stub — add new stubs to `__mocks__/obsidian.ts` if a class or function is missing.
- Never remove or disable existing tests.

---

## CI pipeline

Three jobs run on push/PR to `main` and on a weekly schedule:

1. **check**: type-check → lint → test → build → manifest validation → deprecated-API scan → bundle size check (warns if > 500 KB)
2. **osv-scan**: OSV dependency vulnerability scan via `package-lock.json`
3. **dependency-review** (PRs only): fails on high-severity new dependencies

---

## Releases

Releases are triggered by pushing a version tag. The release workflow:
1. Runs tests and build.
2. Generates SLSA build provenance attestation for `main.js`, `manifest.json`, and `styles.css`.
3. Submits artifacts to VirusTotal (requires `VT_API_KEY` secret; non-fatal if absent).
4. Extracts the matching section from `CHANGELOG.md` as release notes.
5. Creates the GitHub release.

**Contributors do not bump versions or cut releases.** Before opening a PR, add a user-visible entry under `## [Unreleased]` in `CHANGELOG.md`.

---

## Common pitfalls

- **Marker format changes must be reflected in `parser.ts`** (the source of truth). Updating the format in one place and not the other will cause silent data loss or parse failures.
- **Category name rules are strict.** An invalid category name silently fails to match the parser regex and markers with that category will not be indexed.
- **`-->` inside an `annoteca-original` fence closes the HTML comment.** The caller must ensure the captured prose does not contain `-->`. Check `comment-service.ts` for how existing code handles this.
- **Stale marker positions.** Operations triggered from the side panel should re-resolve the marker by its `id` against current file content before editing, not use a cached `marker.start/end`. See `comment-service.ts` for the pattern.
- **Anything the editor decorations read must be a declared CodeMirror dependency, or it will not repaint.** `EditorView.decorations.compute(deps, ...)` only re-runs when one of `deps` changes. A module-level flag or a value reached through `ctx.getSettings()` is invisible to that machinery, so changing it appears to do nothing until an unrelated edit or click recomputes the facet for some other reason. Focusing the editor is not enough. This has bitten three times: hide-all, inline comment bodies, and every editor-indicator setting. The pattern is in `decorations.ts`: mirror the value into a `StateField`, list that field in `deps`, and dispatch an effect into every view in `liveViews`. Settings are already covered wholesale by `refreshDecorationsEverywhere()`, which `saveSettings` calls.
- **A command must not re-derive the drawing code's conditions.** If a command needs to know whether pressing it would produce anything visible, ask a predicate that lives beside the drawing code (see `inlineBodiesBlockedBy` in `decorations.ts`). Enumerating the gates at the call site drifts the moment a new early return is added to `decorationsCompute`.
- **`npm run lint` runs `scripts/check-submission.mjs`** in addition to ESLint. That script checks manifest description constraints, `!important` in CSS, and ESLint directive hygiene. Read it before adding new lint suppressions.
- **`npm run lint` also runs `prettier --check "**/*.ts"`.** Formatting is a hard gate, so hand-formatted or scripted edits that Prettier would rewrite fail CI. Fix with `npx prettier --write`, never by editing `.prettierrc.json`. The scope is TypeScript only; `styles.css`, `manifest.json`, and the `.mjs` scripts are deliberately outside it.
- **The test vault auto-copy** in `esbuild.config.mjs` looks for `../../obs-test-vault`. It silently skips if absent — this is expected on CI and in most dev environments.
