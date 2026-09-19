# Integrating with Annoteca

Annoteca stores review comments as plain HTML comments inside your Markdown notes.
That makes it a good backend for any plugin that wants to attach notes, bookmarks,
threads, or AI-readable instructions to a place in a document, without inventing its
own comment store.

This guide is for plugin developers. It has three tiers, smallest first. Pick the
lowest one that does what you need.

Two promises shape the whole API:

- No hard dependency, either direction. Do not add Annoteca to your manifest and do
  not throw when it is missing. Every tier degrades to "Annoteca not present" as a
  normal state.
- Annoteca owns note prose and markers. A consumer reads, and creates comments
  through the API. It never edits, resolves, or deletes a comment it did not create,
  because deciding a comment is dealt with is a judgement about the writing.

## Tier 0: show that a comment is there (no dependency, no API)

Annoteca comments are HTML comments with a self-identifying prefix, so any tool can
find them by matching text. You do not need Annoteca installed or its API to detect
one and draw your own indicator.

The marker form:

```
<!-- annoteca/<category>: <body> -->
```

`<category>` is a lowercase, dash-separated id (`tone`, `clarify`, `verse-needed`).
A marker may lead or trail the prose it concerns. To tell whether a block carries a
comment and in which category, match the opener:

```ts
const OPENER = /<!--\s*annoteca\/([a-z0-9-]+)\s*:/g;
for (const m of block.matchAll(OPENER)) {
	const category = m[1]; // e.g. "clarify"
	// draw a badge on your node / row for this block
}
```

That is enough to render a "has comment" dot, a per-category colour, or a count, with
zero coupling. The comment stays a valid HTML comment when Annoteca is uninstalled, so
a note you display is safe either way.

For a live count, resolved/open state, or where the prose actually sits, use Tier 1
instead of parsing the body yourself. The body can span lines and carry threads,
metadata, and an end-of-file store, so hand-parsing past "is there a marker" is a trap.

## Getting the types

Copy [`annoteca-api.d.ts`](./annoteca-api.d.ts) into your plugin. It is a single file
with no imports and no runtime, so it adds no dependency: it is only the type shape of
the object you resolve at call time.

## Resolving the API

Resolve it at CALL time, never in your `onload`:

```ts
import type { App } from 'obsidian';
import type { AnnotecaApi } from './annoteca-api';

// `app.plugins` is an Obsidian internal that the official types do not declare,
// so reach it through a minimal local shape rather than the official `App`. This
// compiles against the stock `obsidian` types plus the copied declaration alone.
interface PluginsRegistry {
	getPlugin(id: string): { api?: unknown } | null;
}

function annoteca(app: App): AnnotecaApi | undefined {
	const registry = (app as { plugins?: PluginsRegistry }).plugins;
	const api = registry?.getPlugin('annoteca')?.api as
		| AnnotecaApi
		| undefined;
	// Gate on the floor you need. Unknown or lower means degrade.
	return api && api.apiVersion >= 3 ? api : undefined;
}
```

Caching the object in `onload` is the one thing that makes plugin load order matter,
and it is a bug rather than a hazard to work around. `isEnabled('annoteca')` is not an
availability test: it reports saved config, so it answers `true` for a disabled,
unloaded plugin. Availability is `getPlugin('annoteca') !== null` plus an `apiVersion`
check.

To show or hide UI as Annoteca is enabled or disabled mid-session, subscribe to
`app.plugins.on('changed', ...)` and re-resolve.

## Versioning

`apiVersion` is a single integer, a capability floor. It is not the plugin's release
version (that is the semver in the manifest, and the two move independently).

- `1`: read only (`queryComments`, `anchorsFor`, `onChange`).
- `2`: adds `promote` (and `categories`, which rides alongside it).
- `3`: adds `reveal`.

The rules the API holds to, so you can depend on a version:

- `apiVersion` moves up when a method you are expected to gate on lands. It never moves
  down, and a method never disappears or changes signature within a version.
- A new field on a returned object can appear without moving `apiVersion`. Read what
  you know and ignore the rest. (`AnchorRange.addressed` arrived this way.)
- Always feature-detect the exact method you call, and treat `apiVersion` as the floor.
  A build can carry an additive method while still reporting the older number.

## Tier 1: read comments

```ts
const api = annoteca(this.app);
if (!api) return; // Annoteca absent, degrade

// Open comments across the vault, or filter by path/category/state.
const open = await api.queryComments({ paths: [file.path] });

// Where each comment's prose sits in text you hold (an editor's live text,
// NOT the on-disk copy). Pure over its input.
const ranges = api.anchorsFor(editorText);

// Offer the user's own categories rather than hardcoding a list that drifts.
const categories = api.categories();

// Re-render when comments change. Returns its own unsubscribe; call it on unload.
const off = api.onChange(() => this.refresh());
this.register(off);
```

`queryComments` is async because the comment index fills lazily; it awaits a vault scan
so the answer is vault-wide rather than only the files touched this session. It returns
copies of a narrow shape, never Annoteca's internal comment objects.

## Tier 2: create comments and jump to them

### Create

```ts
const created = await api.promote(
	file.path,
	[
		{
			category: 'clarify',
			body: 'Which products does this cover?',
			anchor: { start, end }, // offsets into `expected`
			author: 'your-plugin-id',
			sourceKey: stableKeyForThisFinding,
		},
	],
	expected, // the note content the anchors were computed against
);
```

Notes on `promote`:

- Create only. There is no path to resolve, edit, delete, or reply. A consumer that
  wants a finding retracted replies to it (as a person would).
- Idempotent on `author:sourceKey`. Promoting the same finding twice is a no-op, not a
  second marker, so re-running over a note you already commented on is safe.
- Budget-gated. Above the user's promotion budget (default 10 in one call) the user is
  asked first, with the count and note named. A refusal returns an empty array.
- `expected` guards against a stale write. If the note moved on since you read it, the
  call returns an empty array rather than placing a marker in the wrong prose. Re-read
  and call again. Record what came back: a returned `CreatedComment` is the only proof
  a comment was written.

### Jump to a comment

```ts
// From your own indicator: open the note, scroll to the comment, open its thread.
const ok = await api.reveal(commentId); // false if no comment has that id
```

`reveal` is read-and-navigate only. Pair it with Tier 0 or Tier 1: draw an indicator
for a comment, and on click call `reveal(comment.id)`.

## Author and source conventions

Pick a stable `author` (use your plugin id) and a stable `sourceKey` (your own identity
for the thing the comment is about, e.g. a block id or a finding hash). A created
comment carries `[author=<id>]` and `[source=<id>:<key>]`, so it reads as yours and
Annoteca can tell it apart from a human comment without a side index. The idempotency
above keys on `author:sourceKey`.

## Etiquette

- Never resolve, edit, or delete a comment your plugin did not create.
- Do not batch huge promotions to dodge the budget prompt; it exists to protect the
  user's note from any consumer.
- Degrade cleanly. With Annoteca absent, your plugin should be a complete product on
  its own.
