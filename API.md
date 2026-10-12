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

A complete, compilable walkthrough of every call is in
[`examples/api-consumer.ts`](./examples/api-consumer.ts).

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
- `4`: `promote` takes an optional `closeRange` per request and reports `closed` on each
  created comment. Nothing earlier changed shape.
- `5`: adds `compose`.
- `6`: adds `onCommentEvent`.
- `7`: adds `resolve` and `reopen`.

Gate on the level the method you call needs (`>= 2` to create, `>= 3` to reveal, `>= 4`
to ask for range comments, `>= 5` to compose, `>= 6` for comment events, `>= 7` to
resolve or reopen), and treat it as a floor:

- `apiVersion` moves up when a method you are expected to gate on lands. It never moves
  down, and a method never disappears or changes signature within a level.
- A new field on a returned object can appear without moving `apiVersion`. Read what you
  know and ignore the rest (`AnchorRange.addressed` arrived this way).
- Feature-detect the exact method you call as well, since a build can carry an additive
  method while still reporting the older number.

## Method reference

The whole contract. Resolve `api` as above, then:

- `apiVersion: number`. The capability level the running build supports.
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
- `compose(path, range): Promise<boolean>`. Ask the user to comment on exactly
  `range` (`{start, end}`, editor offsets) of a note: Annoteca opens the note, selects that
  text and opens its own comment form, so the comment is the user's, with a closing marker
  covering that text. Nothing is written until the user saves. Resolves `false`, opening
  nothing, for a path that is not a markdown note or a range that is empty, out of bounds,
  or starts or ends inside existing comment syntax or the note properties. Use it for a
  "comment on this" action in your own view (a mind map node, an outline row). Needs
  `apiVersion >= 5`.
- `resolve(commentId): Promise<ApiWriteResult>` and `reopen(commentId):
  Promise<ApiWriteResult>`. Resolve or reopen a comment exactly as a click in the hub
  does. Only for an action the reader takes in your view. See Resolving and reopening
  below. Needs `apiVersion >= 7`.
- `onChange(cb): () => void`. Fires when the comment index changes. Returns its own
  unsubscribe; call it on unload.
- `onCommentEvent(cb): () => void`. Calls `cb` with an `ApiCommentEvent` for each thing
  that happened to a comment. See Following changes below. Returns its own unsubscribe;
  call it on unload. Needs `apiVersion >= 6`.

Return and argument shapes, so you can build against this page alone:

- `ApiComment` (from `queryComments`): `id?`, `path`, `category`, `body`, `author?`,
  `date?`, `resolved`, `addressed` (a proposed edit is awaiting accept/revise/reject, so
  the comment is still open), `replyCount`, `anchor?` as `{text, truncated}` (the prose
  captured at creation), and `marker` as `{start, end}` (where the marker sits, which is
  the head of the passage, not where the prose is: use `anchorsFor` for that). Marker
  offsets are into the note's editor text, so a line break counts as one character even in a
  file saved with Windows (CRLF) line endings.
- `AnchorRange` (from `anchorsFor`): `start`, `end`, `category`, `resolved`, `addressed`,
  `commentId?`. Where the prose actually sits in the content you passed. For a range
  comment, one that ends with a closing marker `<!-- /annoteca <id> -->`, this is exactly
  the text between the two markers, however long. Otherwise it is located by matching the
  captured anchor text next to the marker. If you detect markers yourself, skip closers
  too: they are separate HTML comments, and they do not match the opener pattern below.
- `PromoteRequest` (into `promote`): `category`, `body`, `anchor` as `{start, end}`,
  `author`, `sourceKey`, and optional `closeRange` (`apiVersion >= 4`). Shown in Creating
  below.
- `CreatedComment` (from `promote`): `id`, `sourceKey`, and `closed?` (`apiVersion >= 4`).
- `ApiWriteResult` (from `resolve` and `reopen`): `'done'`, `'unchanged'`, `'not-found'`,
  `'addressed'` or `'blocked'`. Shown in Resolving and reopening below.
- `ApiCommentEvent` (from `onCommentEvent`): `type`, `id?`, `path?`, `oldPath?`,
  `category?`, `author?`, `date?`, `source?` as `{tag, key}`, `reason?`. Shown in
  Following changes below.

The exact declarations, with `readonly` and optionality, are in `annoteca-api.d.ts`.

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
for (const c of open) {
	// c.category, c.body, c.resolved, c.replyCount, c.anchor?.text, c.marker.start
	console.log(`${c.category}: ${c.body} (${c.replyCount} replies)`);
}

// Where the prose actually sits, in the text you pass (live editor text).
const ranges = api.anchorsFor(editorText);
for (const r of ranges) {
	const words = editorText.slice(r.start, r.end); // r.category, r.resolved, r.commentId
}

const categories = api.categories(); // [{ id, displayName }]

const off = api.onChange(() => this.refresh());
this.register(off);
```

## Following changes

`onChange` says only that something changed. `onCommentEvent` says what happened to which
comment, so a consumer that answers or tracks comments does not have to re-read and diff
the vault:

```ts
if (api.apiVersion >= 6) {
	const off = api.onCommentEvent((e) => {
		if (e.type === 'resync') return void this.reconcile(); // re-read with queryComments
		if (e.type === 'created' && e.source === undefined) this.queue(e.id, e.path);
	});
	this.register(off);
}
```

Each event has a `type`:

| `type` | Meaning | `author` / `date` |
| --- | --- | --- |
| `created` | A new comment appeared. | The comment's author and date. |
| `replied` | A reply was added. One event per new reply. | The reply's. |
| `addressed` | A proposed edit was applied and awaits review. | Who applied it. |
| `resolved` | The comment was resolved. | Who resolved it. |
| `reopened` | A resolved comment is open again. | Absent. |
| `moved` | The comment is now in another note: the note was renamed, or the comment was cut from one note and pasted in another. `oldPath` is where it was. | Absent. |
| `deleted` | The comment is gone. `path` is where it was. | Absent. |
| `resync` | Events start here. Anything earlier, read with `queryComments`. | Absent. |

Every event except `resync` carries `id`, `path` and `category`, and `source` when the
comment was created through `promote`, so you can tell your own findings from the
user's without a side index. Events carry no comment text: read the note, or call
`queryComments`, for the body.

How events behave:

- They come from Annoteca's comment index, so a comment written by the composer, by
  `promote`, by hand in the note, or by another device through sync is reported the same
  way.
- They arrive once a burst of changes settles: about 2.5 seconds after the last change,
  and no more than about 10 seconds after the first while a note keeps changing. A note's
  content can briefly read stale while it saves; reporting the settled state keeps that
  from showing up as deleted and created again.
- They follow comments by id. A comment without an id is never reported.
- Subscribing starts the vault scan if it has not run. Every subscription opens with one
  `resync` event once the scan is done, also one made long after, and nothing else
  arrives before it. A note seen for the first time before the scan finished was already
  there, not new.
- Reply events count replies. A reply that was edited or removed reports nothing.
- Nothing is reported while Obsidian is closed. Reconcile with `queryComments` when you
  start, then follow events.

### The event journal (outside Obsidian)

A tool that runs outside Obsidian cannot subscribe. For those, the user can turn on
**Write event journal** in Settings > AI integration (off by default). Each event is then
appended as one line of JSON to `events.jsonl` in the plugin folder
(`<vault>/.obsidian/plugins/annoteca/events.jsonl`), with an `at` timestamp added:

```json
{"at":"2026-10-12T15:50:22.798Z","type":"created","id":"zzev0001","path":"notes/draft.md","category":"clarify","author":"ed","date":"2026-10-12"}
```

Follow it with `tail -F`, or any watcher that follows a file by name. The file is only
ever appended to. Past about 5 MB it is renamed to `events.1.jsonl`, replacing the
previous one, and a new `events.jsonl` starts, which `tail -F` picks up. A `resync` line
with `"reason": "journal-on"` is written when the user turns the journal on, and one with
`"reason": "scan"` when events start after Obsidian loads; treat either as "reconcile now".
Nothing in the journal leaves the device, and it holds no comment text.

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
	expected, // the note's editor text the anchors were computed against
);
```

Notes on `promote`:

- Create only. `promote` never edits, deletes or replies to a comment. If a finding needs
  retracting, the user replies to it by hand; the API has no reply. Resolving and
  reopening are separate calls for the reader's own actions, below.
- Idempotent on `author:sourceKey`. Promoting the same finding twice is a no-op, not a
  second marker, so re-running over a note you already commented on is safe.
- Budget-gated. Above the user's promotion budget (default 10 in one call) the user is
  asked first, with the count and note named. A refusal returns an empty array.
- `expected` is editor text, where a line break is one character. On a note saved with
  Windows (CRLF) line endings the file's raw bytes are not the same text, and passing them
  gets an empty array. Use the editor's value, or the vault's bytes with every `\r\n` and
  lone `\r` turned into `\n`.
- `expected` guards against a stale write. If the note moved on since you read it, the
  call returns an empty array rather than placing a marker in the wrong prose. Re-read
  and call again. A returned `CreatedComment` is the only proof a comment was written.
- Range comments (`apiVersion >= 4`). Set `closeRange: true` on a request and Annoteca
  also writes a closing marker, `<!-- /annoteca <id> -->`, after the last non-whitespace
  character before `anchor.end`, so trailing spaces and line breaks in your range stay
  outside it. It is off by default, and an older build ignores it. No closer is written
  where HTML would show (a code block, inline code) or when the range is only whitespace;
  that request still creates a start-only comment, and `closed` on the returned
  `CreatedComment` says which happened. An anchor that touches the note properties is a
  different case: it is invalid, and the whole call returns an empty array, as before.

Reveal, to jump to a comment from your own indicator:

```ts
const ok = await api.reveal(commentId); // false if no comment has that id
```

`reveal` navigates only, it never writes. Pair it with detection or `queryComments`: draw
an indicator for a comment, and on click call `reveal(comment.id)`.

## Resolving and reopening

For a Resolve or Reopen action the reader clicks in your own view (`apiVersion >= 7`):

```ts
const result = await api.resolve(commentId); // or api.reopen(commentId)
```

- It is the hub's own action, not a second one: the same write queue and freshness
  guards, the reader's author tag on the resolution, and the same notice ("Resolved.",
  "Reopened.", "Already resolved."). Do not show your own notice for `'done'` or
  `'unchanged'`.
- `resolve` honours the reader's delete-on-resolve setting. With it on, the comment and
  its thread are removed from the note, as a hub click would do.
- `resolve` never decides a proposed edit. A comment with `addressed: true` answers
  `'addressed'` and nothing is written; send the reader to it with `reveal` so they
  accept, revise or reject it there.
- The other answers: `'not-found'` (no indexed note carries that id, so it may have been
  deleted since you read it), `'unchanged'` (already resolved, or already open for
  `reopen`), and `'blocked'` (Annoteca refused because the comment syntax around it is
  damaged, and has already told the reader).
- Only for the reader's own click. Never call these from a scan, a timer or a rule.

## Author and source conventions

Pick a stable `author` (use your plugin id) and a stable `sourceKey` (your own identity
for the thing the comment is about, e.g. a block id or a finding hash). A created comment
carries `[author=<id>]` and `[source=<id>:<key>]`, so it reads as yours and Annoteca can
tell it apart from a human comment without a side index. The idempotency above keys on
`author:sourceKey`.

## Etiquette

- Never resolve, reopen, edit, or delete a comment on your own initiative. `resolve` and
  `reopen` are for an action the reader takes, on the comment they chose.
- Do not batch huge promotions to dodge the budget prompt; it exists to protect the
  user's note from any consumer.
- Degrade cleanly. With Annoteca absent, your plugin should be a complete product on its
  own.
