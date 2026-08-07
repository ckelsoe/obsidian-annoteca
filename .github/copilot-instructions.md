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
| `markdown-render.ts` | The only place that calls `MarkdownRenderer`; owns render-component lifetimes |
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
npm run lint         # ESLint (zero warnings allowed) + prettier --check "**/*.ts"
                     #   + scripts/check-submission.mjs
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
- Anchor text: the SELECTION capture caps at 80 visible characters, mid-truncated with `…`. `serialize()` enforces a separate 200-character ceiling on the escaped value, and the parser accepts any length so an anchor written by hand or by an older build is read rather than silently dropped. Two limits, two jobs: 80 is the capture budget, 200 is the format's.
- Replies are sorted chronologically by timestamp on read; file order is the tiebreak for equal timestamps.
- The `-->` sequence cannot appear literally in any free-text field, because it closes the HTML comment wrapper. `parser.ts` escapes it as `--\>` on write and restores it on read, for the body, `[anchor=...]`, reply bodies, the addressed and resolved notes, and the `annoteca-original` fence. Anything that writes a marker must go through `serialize()`; do not hand-build one.
- Every bracketed trailing line is a SINGLE-LINE grammar, so `serialize()` collapses a run of line breaks to one space in `[anchor=...]`, reply bodies, and the addressed and resolved notes. A raw newline in one of those emits a continuation line that matches nothing, which ends the parser's backward walk on the spot and absorbs the `[id=...]` and every other trailing line into the body. The comment body and the `annoteca-original` fence are multi-line by contract and are NOT collapsed. `skill-export.ts` states this rule for assistants; it applies to plugin code too.
- The `annoteca-original` fence is the addressed note's original when it appears anywhere after the last `[addressed ...]` line that is not itself inside a fence. Adjacency is NOT required and must not be reintroduced: `serialize()` writes the fence on the next line, but hand-written and assistant-written markers put a blank line or a `[reply ...]` in between, and requiring adjacency leaves the fence in place to stop the backward walk, which destroys the whole comment.
- Forward-compatibility: a trailing line in a shape the format defines but this version does not recognize is ignored by the parser. That means exactly two shapes, `[key=value]` alone on the line, and `[key <author> <timestamp>]:`, where key is `[a-z][a-z0-9-]*`. **Not** "any line starting with `[`": bodies are markdown, and `[label](url)`, `[ref]: url`, `[^1]: note` and `[[Wikilink]]` all begin with a bracket. Treating those as structured deleted the last line of the body. When a trailing line is ambiguous, keep it in the body: lost prose is unrecoverable, an unparsed structured line is merely visible.

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
- Editor-aware writes: when a file is open in a markdown leaf, mutate through the editor's `replaceRange` rather than a vault write. A vault write on an open file can be clobbered by the editor's autosave flushing its stale in-memory document back to disk. When the file is NOT open, write with `vault.process(file, fn)`, never `read` then `modify`: process reads and writes under one lock, so nothing can land in between.
- `applySplices` takes the exact content the caller computed its offsets against and REFUSES when the file no longer matches it. Two rules follow, and both have already been broken once. Pass the content you actually read, not a fresh read. Honour the return value: a refusal that is not propagated looks identical to a success one layer up, and the verb then reports "Reply added." and clears the draft while nothing reached the file.
- Every public mutating verb on `CommentService` is an `enqueue` wrapper around a private `*Unqueued` method, so this plugin's own writes to one file cannot interleave. A verb that delegates to another verb MUST call the `*Unqueued` form. Calling the public one deadlocks: it waits behind the caller that is already holding that path's queue slot.

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

### There is exactly one settings render path

`minAppVersion` is 1.13.0, so `getSettingDefinitions()` is the only path. The imperative `display()` fallback and the parity script that kept the two in step are both deleted. Do not reintroduce either: a second path that the dev vault never exercises is how a row ends up invisible to half the supported range.

`update()` is the re-render entry point, reached through `rerender()`. It rebuilds the tab from fresh definitions: bound controls reconcile, AND a custom block's `render` callback runs again against a NEW host element. Both halves are synchronous, so the new DOM is in place by the time `update()` returns.

This paragraph said the opposite until 2026-08-05, and the code written against it repainted custom blocks by hand before calling `rerender()`. Measured in the running app (Obsidian 1.13.4) by adding a category in memory and calling `update()`: the row count went 8 to 9 immediately, the previous `.annoteca-category-list` node was a different object and already `isConnected === false`, and nothing changed again on a later tick. `containerEl` itself is stable across the call; only its contents are rebuilt.

Two consequences, both load-bearing:

- **Do not hand-repaint a custom block before `rerender()`.** The repaint lands on a node `update()` is about to detach and replace, so it is wasted work that reads as necessary.
- **A DOM reference captured before `rerender()` is dead after it.** Re-find the element from `containerEl`, which survives. `refocusAfterMove` in `settings.ts` is the worked example.

### Every value read out of data.json goes through `normalizeSettings`

`data.json` is user-editable and arrives over sync and out of restored backups, so nothing in it is guaranteed to be the type it was written as. `normalizeSettings(raw, fallback)` in `settings.ts` is the single choke point: it starts from the defaults and copies a key only if that key's validator accepts it. `loadSettings` and `mergeRestoredSettings` are both thin wrappers over it, and no validation logic lives anywhere else.

`SETTING_VALIDATORS` is a mapped type over `Required<AnnotecaSettings>`, so a new setting with no validator fails the build rather than arriving unchecked.

---

## Adding or editing tests

- Tests live in `__tests__/` and are named `*.test.ts`.
- The Jest environment is `node` by default, so there is no DOM. Obsidian APIs are stubbed by `__mocks__/obsidian.ts`.
- A test that needs a real DOM (constructing a CodeMirror `EditorView`, for instance) opts in per file with a `/** @jest-environment jsdom */` docblock, as `__tests__/live-views.test.ts` does. Do not switch the whole suite; the rest does not need it and jsdom is slower.
- Under jsdom you still do NOT get Obsidian's injected DOM helpers (`document.win.createSpan`, `el.createDiv`, and friends). Prefer arranging the test so they are never called, the way `live-views.test.ts` uses `indicatorStyle: 'underline'` to avoid constructing any widget. When the surface under test is itself BUILT from them (the reply composer, the tooltip host), call `installObsidianDomHelpers()` from `__mocks__/obsidian.ts` instead of hand-writing a stub: it installs a strict subset of the real API and clones elements from seeds the test's jsdom `html` option supplies, which is what keeps it clear of `obsidianmd/prefer-create-el`'s ban on `createElement`. See `reply-composer-dismiss.test.ts` for the shape. An ad-hoc injected stub in a test file is still wrong: it puts a second, drifting imitation of Obsidian between the test and the code.
- Shared test doubles go in a non-`*.test.ts` file under `__tests__/` so Jest does not collect them as a suite. `__tests__/stub-context.ts` is the `DecorationContext` double used by more than one suite.
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
- **`-->` is escaped by `serialize()`, not forbidden.** Every free-text field round-trips through `escapeTerminator` / `unescapeTerminator` in `parser.ts`. Do not add a caller-side check that rejects `-->`, and do not write a marker without going through `serialize()`.
- **Stale marker snapshots, not just stale positions.** A panel card holds the `Comment` captured when it was drawn. Re-resolving the marker's `id` for its OFFSETS is necessary but not sufficient: building the write from the cached object serializes its replies, author, timestamps, and addressed state as of render time, silently discarding anything that landed in between. `replaceMarker` in `comment-service.ts` therefore takes a TRANSITION (`current => next`) applied to the freshly re-read comment, and returns whether it wrote so the caller can pick the right Notice. Add new lifecycle verbs that way; do not reintroduce a `next`-shaped parameter.
- **An `Editor` does not belong to a file, so re-check the file at WRITE time.** Obsidian reuses the same `Editor` object when a markdown leaf switches file, and the stale reference then reads and writes the NEW file's buffer. The default composer is the side panel, whose whole point is that the editor stays usable behind the form, so a wikilink click, a file-explorer click or Make a copy while it is open is ordinary rather than exotic. Any surface holding an `Editor` across user interaction therefore carries the view it came from (`ComposerRequest.view`, a required field on purpose) and compares `view.file?.path` to the captured path immediately before writing, refusing rather than redirecting. Open-time checks do not count; the one this replaced ran when the form opened and Save still wrote into whatever the tab had moved on to. Take the path from that view too, never from `getActiveFile()`, or the check has nothing it can agree with.
- **An id-less marker is identified by its own text, plus the card that asked for it.** The format allows a marker with no `[id=...]`, and `convert comments` emits them with no id, no date and no author, so a run of them differs only in body and two of equal body length have equal extent. Offset plus category plus extent is therefore not an identity: deleting a line above slides the next marker onto the remembered offset. Compare the marker's exact source text as captured when the form opened, AND the category and body of the snapshot that was clicked. Both, not either: the fingerprint is read using the snapshot's offsets, so on its own it agrees with itself whenever the snapshot was already stale. Two byte-identical markers stay indistinguishable, which is a placement cost and never a content one.
- **Comment text renders as markdown through one entry point.** `markdown-render.ts` owns it. Never call `MarkdownRenderer.render` directly from a surface. Two rules go with it: the inline body widget in `decorations.ts` stays plain `textContent` (rendered headings and lists repeated at every marker destroy the document's layout, which is the opposite of what that feature is for), and the `annoteca-original` text stays plain everywhere (it is the verbatim prose Reject would restore, so it must be shown as what would be written back, not as what it renders to).
- **Every ephemeral markdown surface needs a `Component` that is later unloaded.** `MarkdownRenderer.render` attaches child components for embeds and code-block processors. A CodeMirror tooltip gets one per instance, unloaded in its `destroy` hook; the Hub panel cycles one per render pass via `cycleLifetime`. Passing a long-lived component (the plugin, the view) leaks on every hover and every panel refresh.
- **Markdown renders asynchronously, and CodeMirror tooltips size themselves synchronously.** A popover built with `create()` is measured and positioned before an async render lands, so it ends up mis-sized and visibly misplaced above its anchor. Call `repositionTooltips(view)` once the render settles; that is what the host's `onRendered` hook is for.
- **A CodeMirror tooltip must be parented outside the leaf, per view, and never via `appendConfig`.** `.workspace-leaf` computes `contain: strict`, which makes the leaf the containing block for `position: fixed` descendants AND paint-clips them to it, so a tooltip left to mount inside `view.dom` is cut off, not merely squeezed. `tooltipSpace` does not help; it only sets the rectangle CodeMirror positions within, and its default is already the editor's own window viewport. The parent also cannot be captured once at load (`activeDocument.body` sends every window's popovers to whichever window was active then), and it cannot be re-pointed with `StateEffect.appendConfig`, because appended values accumulate and `tooltipConfig` combines by taking the FIRST value carrying a parent. `perWindowTooltipHost` in `decorations.ts` is the pattern: one host element per `EditorView`, applied through a `Compartment` so reconfiguration replaces rather than stacks, re-parented on `update()` because Obsidian moves the SAME `EditorView` into a popout window rather than rebuilding it.
- **A pinned tooltip's `create` identity is what keeps its DOM alive, so nothing it captures may be a snapshot.** CodeMirror matches tooltip views by `create` identity: rebuild the Tooltip object with a fresh closure and the live DOM is destroyed, which wipes a half-written reply (id-less comments have no draft to restore from). So a pinned surface spreads its existing tooltip and keeps the same `create`. The consequence is that whatever the closure captured is frozen, and `CommentService` resolves an id-less comment by its OFFSETS, so a captured `Comment` stops matching after any edit above it and every action reports it as vanished. Read the comment through a ref that the field re-points on each remap (`CommentRef` in `decorations.ts`), never a captured value.
- **Map a marker offset with `assoc: 1`.** `mapPos` defaults to `-1`, which keeps a position before text inserted exactly at it. A marker is not a cursor: typing at the end of the prose immediately in front of one puts those characters ahead of the `<!--`, so the marker starts after them and a default-association lookup misses by what was typed and reads as "deleted".
- **Anything the editor decorations read must be a declared CodeMirror dependency, or it will not repaint.** `EditorView.decorations.compute(deps, ...)` only re-runs when one of `deps` changes. A module-level flag or a value reached through `ctx.getSettings()` is invisible to that machinery, so changing it appears to do nothing until an unrelated edit or click recomputes the facet for some other reason. Focusing the editor is not enough. This has bitten three times: hide-all, inline comment bodies, and every editor-indicator setting. The pattern is in `decorations.ts`: mirror the value into a `StateField`, list that field in `deps`, and dispatch an effect into every view in `liveViews`. Settings are already covered wholesale by `refreshDecorationsEverywhere()`, which `saveSettings` calls.
- **A command must not re-derive the drawing code's conditions.** If a command needs to know whether pressing it would produce anything visible, ask a predicate that lives beside the drawing code (see `inlineBodiesBlockedBy` in `decorations.ts`). Enumerating the gates at the call site drifts the moment a new early return is added to `decorationsCompute`.
- **`npm run lint` runs `scripts/check-submission.mjs`** in addition to ESLint. That script checks manifest description constraints, `!important` in CSS, and ESLint directive hygiene. Read it before adding new lint suppressions.
- **`npm run lint` also runs `prettier --check "**/*.ts"`.** Formatting is a hard gate, so hand-formatted or scripted edits that Prettier would rewrite fail CI. Fix with `npx prettier --write`, never by editing `.prettierrc.json`. The scope is TypeScript only; `styles.css`, `manifest.json`, and the `.mjs` scripts are deliberately outside it.
- **The test vault auto-copy** in `esbuild.config.mjs` looks for `../../obs-test-vault`. It silently skips if absent — this is expected on CI and in most dev environments.
