// Annoteca's public plugin API, as a standalone declaration.
//
// This is the file another plugin copies to get types for Annoteca's API. It has
// no imports and no runtime, so copying it adds no dependency on Annoteca: the
// consumer still resolves the live object at call time and works when Annoteca is
// absent. See INTEGRATING.md for the full guide.
//
// Resolve the API at CALL time, never in your onload. `app.plugins` is an Obsidian
// internal the official types do not declare, so reach it through a minimal local
// shape; INTEGRATING.md has a lookup that compiles against the stock types plus this
// file alone. Gate on `apiVersion >= 3` and degrade below it.
//
// Caching it is the only thing that makes plugin load order matter, and
// `isEnabled('annoteca')` is not an availability test (it reports saved config, so
// it answers true for a disabled, unloaded plugin). Availability is
// `getPlugin('annoteca') !== null` plus an `apiVersion` check.
//
// This file is kept byte-compatible with the shipped runtime surface by a locking
// test in the plugin's own repo, so what a consumer copies is what the plugin
// exposes.

// A comment as a consumer sees it. Deliberately narrow: it does not carry the
// marker grammar or the reply and addressed structures the file format needs, so
// none of those become something the API can never change.
export interface ApiComment {
	readonly id: string | undefined;
	readonly path: string;
	readonly category: string;
	readonly body: string;
	readonly author: string | undefined;
	readonly date: string | undefined;
	readonly resolved: boolean;
	// A proposed edit is in the note awaiting accept, revise or reject. Such a
	// comment is still open, so it is counted as unresolved.
	readonly addressed: boolean;
	readonly replyCount: number;
	// The prose the comment was made about, captured when it was created.
	// `truncated` means the original selection was longer than the stored text.
	readonly anchor:
		{ readonly text: string; readonly truncated: boolean } | undefined;
	// Where the marker itself sits in the file. A marker is written at the HEAD
	// of the passage it concerns, which is not where the prose sits: use
	// anchorsFor for that.
	readonly marker: { readonly start: number; readonly end: number };
}

// Where a comment's prose sits in the current text, resolved from content the
// consumer supplies.
export interface AnchorRange {
	readonly start: number;
	readonly end: number;
	readonly category: string;
	readonly resolved: boolean;
	// A proposed edit is awaiting accept, revise or reject. `resolved` alone
	// cannot tell this apart from an untouched comment, because both are open.
	readonly addressed: boolean;
	readonly commentId: string | undefined;
}

// A category a comment may be created in, with its display name. Icons and colours
// stay internal on purpose.
export interface ApiCategory {
	readonly id: string;
	readonly displayName: string;
}

export interface ApiFilter {
	readonly paths?: readonly string[];
	readonly categories?: readonly string[];
	// Defaults to 'open', which is the question a consumer usually has.
	readonly resolved?: 'open' | 'resolved' | 'all';
	readonly author?: string;
}

// One comment a consumer asks Annoteca to create. Offsets are into the note's
// CURRENT content, the same text passed to anchorsFor and to promote's `expected`.
export interface PromoteRequest {
	category: string;
	body: string;
	// The marker is placed at `start`; the text between start and end becomes the
	// anchor.
	anchor: { start: number; end: number };
	// Your plugin's id. Used as both the author tag and the source tag, so a
	// created comment reads as authored by your plugin and carries its provenance.
	author: string;
	// Your plugin's own identity for the finding. Creation is idempotent on it:
	// promoting the same finding twice is a no-op, not a second marker.
	sourceKey: string;
}

export interface CreatedComment {
	id: string;
	sourceKey: string;
}

export interface AnnotecaApi {
	// A capability floor to gate on. Feature-detect the exact method you call as
	// well; unknown or lower than you need means degrade to unpaired behaviour.
	readonly apiVersion: number;
	// The generation of the exported assistant guidance (SKILL.md), NOT the marker
	// format. Use it to tell which SKILL.md a build ships, not as a format gate.
	readonly skillSchemaVersion: number;

	// The categories a comment may be created in, in the user's own order, with
	// their display names. Offer these rather than hardcoding a list that drifts
	// when the user adds or renames one.
	categories(): readonly ApiCategory[];

	// The open comments for a note or the whole vault. Async because the index is
	// populated lazily; this awaits the vault scan so the answer is vault-wide.
	queryComments(filter?: ApiFilter): Promise<readonly ApiComment[]>;

	// Where each comment's prose sits in the supplied content. Pure over its
	// input: pass the text you are reasoning about (an editor's live text, not the
	// on-disk copy), and it parses that rather than the vault or the stale index.
	anchorsFor(content: string): readonly AnchorRange[];

	// Create comments on your behalf. CREATE ONLY: there is no path to resolve,
	// delete, edit or reply, because resolution is a judgement about the writing.
	// Idempotent on `author:sourceKey`. Above the user's promotion budget it asks
	// first, and a refusal (or a stale `expected`) returns an empty array rather
	// than throwing. `expected` is the note content the anchors were computed
	// against; re-read and call again if it comes back empty.
	promote(
		path: string,
		requests: readonly PromoteRequest[],
		expected: string,
	): Promise<readonly CreatedComment[]>;

	// Open the note holding a comment, scroll to it, and open its thread. For a
	// consumer that draws its own indicator and wants a click to land the reader
	// on the comment. Resolves `false` when no comment carries that id.
	reveal(commentId: string): Promise<boolean>;

	// Fires when the comment index changes. Returns its own unsubscribe; call it
	// on unload or the callback outlives your plugin.
	onChange(cb: () => void): () => void;
}
