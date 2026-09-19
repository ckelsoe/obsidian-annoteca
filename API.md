# Annoteca plugin API

Annoteca exposes a public, versioned API that other Obsidian plugins can build on.
It is a supported integration surface with an `apiVersion`, a stability policy, and an
optional type declaration you can copy in.

Annoteca stores review comments as plain HTML comments inside your Markdown notes.
That makes it a good backend for any plugin that wants to attach notes, bookmarks,
threads, or AI-readable instructions to a place in a document, without inventing its
own comment store.

Use as little of it as you need. Many integrations only need to tell that a comment
exists; some read comments; a few create them.

Two promises shape the whole API:

- No hard dependency, either direction. Do not add Annoteca to your manifest and do not
  throw when it is missing. It degrades to "Annoteca not present" as a normal state.
- Annoteca owns note prose and markers. A consumer reads, and creates comments through
  the API. It never edits, resolves, or deletes a comment it did not create, because
  deciding a comment is dealt with is a judgement about the writing.

## Using the API

Nothing to install and nothing to copy. The API is a plain runtime object on the
Annoteca plugin instance, reached at `app.plugins.getPlugin('annoteca')?.api`. Resolve
it at CALL time, check `apiVersion`, and call it:

```js
// Plain JavaScript, no types, no files copied.
const api = this.app.plugins.getPlugin('annoteca')?.api;
if (api && api.apiVersion >= 3) {
	const open = await api.queryComments({ paths: [file.path] });
}
```

Resolve it at call time rather than caching it in your `onload`. Caching the handle is
the one thing that makes plugin load order matter, and it is a bug rather than a hazard
to work around. `isEnabled('annoteca')` is not an availability test: it reports saved
config, so it answers `true` for a disabled, unloaded plugin. Availability is
`getPlugin('annoteca') !== null` plus an `apiVersion` check. To show or hide UI as
Annoteca is enabled or disabled mid-session, subscribe to `app.plugins.on('changed', ...)`
and re-resolve.

## Types (optional)

Everything works untyped, as above. If you want TypeScript type-checking and
autocomplete, you have two choices, neither of which is a dependency:

- Declare the small shape you actually call, inline in your own code.
- Or copy [`annoteca-api.d.ts`](./annoteca-api.d.ts) into your plugin. It has no imports
  and no runtime, so it is types only. It is offered as a convenience and an exact
  reference, not a requirement.

A typed lookup that compiles against the stock `obsidian` types plus that file:

```ts
import type { App } from 'obsidian';
import type { AnnotecaApi } from './annoteca-api';

// `app.plugins` is an Obsidian internal the official types do not declare, so reach it
// through a minimal local shape rather than the official `App`.
interface PluginsRegistry {
	getPlugin(id: string): { api?: unknown } | null;
}

function annoteca(app: App): AnnotecaApi | undefined {
	const registry = (app as { plugins?: PluginsRegistry }).plugins;
	const api = registry?.getPlugin('annoteca')?.api as AnnotecaApi | undefined;
	return api && api.apiVersion >= 3 ? api : undefined; // unknown or lower: degrade
}
```

## Versioning

`apiVersion` is a single integer: the capability level the running build supports. It is
not a count of public releases, and it is not the plugin's semver (that lives in the
manifest and moves on its own). The number grew as methods were added during
development, and all of it ships in the first public release (1.17.0) at level 3:

- `1`: read only (`queryComments`, `anchorsFor`, `onChange`).
- `2`: adds `promote`, plus `categories` beside it.
- `3`: adds `reveal`.

Gate on the level the method you call needs (`>= 2` to create, `>= 3` to reveal), and
treat it as a floor:

- `apiVersion` moves up when a method you are expected to gate on lands. It never moves
  down, and a method never disappears or changes signature within a level.
- A new field on a returned object can appear without moving `apiVersion`. Read what you
  know and ignore the rest (`AnchorRange.addressed` arrived this way).
- Feature-detect the exact method you call as well, since a build can carry an additive
  method while still reporting the older number.

## Method reference

The whole contract. Resolve `api` as above, then:

- `apiVersion: number`, `skillSchemaVersion: number`. The capability level, and the
  generation of the exported AI skill (not the marker format).
- `categories(): {id, displayName}[]`. The user's own comment categories, in their order.
  Offer these rather than hardcoding a list that goes stale.
- `queryComments(filter?): Promise<ApiComment[]>`. Open comments for a note or the whole
  vault. `filter` takes `paths`, `categories`, `resolved` (`open` | `resolved` | `all`),
  and `author`. Async, because it awaits a vault scan so the answer is vault-wide.
  Returns copies of a narrow shape, never Annoteca's internal objects.
- `anchorsFor(content): AnchorRange[]`. Where each comment's prose sits in the text you
  pass. Pure over its input, so pass the live editor text, not the on-disk copy.
- `promote(path, requests, expected): Promise<CreatedComment[]>`. Create comments. See
  Creating below. Needs `apiVersion >= 2`.
- `reveal(commentId): Promise<boolean>`. Open the note holding a comment, scroll to it,
  open its thread. Resolves `false` when no comment has that id. Needs `apiVersion >= 3`.
- `onChange(cb): () => void`. Fires when the comment index changes. Returns its own
  unsubscribe; call it on unload.

The `ApiComment`, `AnchorRange`, `PromoteRequest`, and `CreatedComment` shapes are in
`annoteca-api.d.ts` if you want the exact fields.

## Detecting comments without the API

You do not need Annoteca or its API to tell that a passage has a comment. Comments are
HTML comments with a self-identifying prefix, so any tool can find them by matching text:

```
<!-- annoteca/<category>: <body> -->
```

`<category>` is a lowercase, dash-separated id (`tone`, `clarify`, `verse-needed`). A
marker may lead or trail the prose it concerns. To tell whether a block carries a comment
and in which category, match the opener:

```ts
const OPENER = /<!--\s*annoteca\/([a-z0-9-]+)\s*:/g;
for (const m of block.matchAll(OPENER)) {
	const category = m[1]; // e.g. "clarify"
	// draw a badge on your node / row for this block
}
```

That renders a "has comment" dot, a per-category colour, or a count, with zero coupling,
and the note stays valid when Annoteca is uninstalled. For a live count, open or resolved
state, or where the prose actually sits, use `queryComments` and `anchorsFor` rather than
parsing the body yourself: the body can span lines and carry a thread, metadata, and an
end-of-file store, so hand-parsing past "is there a marker" is a trap.

## Reading comments

```ts
const api = annoteca(this.app); // or the plain getPlugin lookup, untyped
if (!api) return; // Annoteca absent, degrade

const open = await api.queryComments({ paths: [file.path] });
const ranges = api.anchorsFor(editorText); // live editor text
const categories = api.categories();

const off = api.onChange(() => this.refresh());
this.register(off);
```

## Creating and revealing comments

Create:

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

- Create only. There is no path to resolve, edit, delete, or reply. If a finding needs
  retracting, the user replies to it by hand; the API has no reply.
- Idempotent on `author:sourceKey`. Promoting the same finding twice is a no-op, not a
  second marker, so re-running over a note you already commented on is safe.
- Budget-gated. Above the user's promotion budget (default 10 in one call) the user is
  asked first, with the count and note named. A refusal returns an empty array.
- `expected` guards against a stale write. If the note moved on since you read it, the
  call returns an empty array rather than placing a marker in the wrong prose. Re-read
  and call again. A returned `CreatedComment` is the only proof a comment was written.

Reveal, to jump to a comment from your own indicator:

```ts
const ok = await api.reveal(commentId); // false if no comment has that id
```

`reveal` navigates only, it never writes. Pair it with detection or `queryComments`: draw
an indicator for a comment, and on click call `reveal(comment.id)`.

## Author and source conventions

Pick a stable `author` (use your plugin id) and a stable `sourceKey` (your own identity
for the thing the comment is about, e.g. a block id or a finding hash). A created comment
carries `[author=<id>]` and `[source=<id>:<key>]`, so it reads as yours and Annoteca can
tell it apart from a human comment without a side index. The idempotency above keys on
`author:sourceKey`.

## Etiquette

- Never resolve, edit, or delete a comment your plugin did not create.
- Do not batch huge promotions to dodge the budget prompt; it exists to protect the
  user's note from any consumer.
- Degrade cleanly. With Annoteca absent, your plugin should be a complete product on its
  own.
