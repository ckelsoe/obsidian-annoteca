import type { EventRef } from 'obsidian';

import type AnnotecaPlugin from './main';
import type { Comment, CreatedComment, PromoteRequest } from './types';
import { parseDocument } from './document';
import { ANCHOR_WINDOW, resolveAnchorRangeInWindows } from './view-utils';
import { SKILL_SCHEMA_VERSION } from './skill-export';

// The read-only API other plugins call (F-284, interop-contract section 7).
//
// Read-only on purpose, and first. The compatibility promise starts as small as
// it can be, and until `promote()` lands in AN-C2 a consumer bug cannot damage a
// note. Everything here is a pure read over the comment index.
//
// Consumers must resolve this at CALL time through
// `app.plugins.getPlugin('annoteca')?.api` and never cache it in their own
// `onload`. Caching is the only thing that makes plugin load order matter, and
// `isEnabled()` is not an availability test: it reports saved config, so it
// answers true for a disabled, unloaded plugin. See contract 4.5.

export const API_VERSION = 1;

// The shape a consumer sees. Deliberately NOT the internal `Comment`: that
// carries the marker grammar, `unknownLines`, reply and addressed structures
// that exist to round-trip the file format, and every one of them would become
// something this API could not change later. What is here is what a consumer has
// a reason to read.
export interface ApiComment {
	readonly id: string | undefined;
	readonly path: string;
	readonly category: string;
	readonly body: string;
	readonly author: string | undefined;
	readonly date: string | undefined;
	readonly resolved: boolean;
	// Addressed means a proposed edit is in the note awaiting accept, revise or
	// reject. Such a comment is still open, so it is counted as unresolved.
	readonly addressed: boolean;
	readonly replyCount: number;
	// The prose the comment was made about, as captured when it was created.
	// `truncated` means the original selection was longer than the stored text.
	readonly anchor:
		{ readonly text: string; readonly truncated: boolean } | undefined;
	// Where the marker itself sits in the file.
	readonly marker: { readonly start: number; readonly end: number };
}

// Where a comment's prose actually sits in the current text, which is not the
// marker position: a marker is written at the HEAD of the passage it concerns.
export interface AnchorRange {
	readonly start: number;
	readonly end: number;
	readonly category: string;
	readonly resolved: boolean;
	readonly commentId: string | undefined;
}

export interface ApiFilter {
	readonly paths?: readonly string[];
	readonly categories?: readonly string[];
	// Defaults to 'open', which is the question a consumer usually has.
	readonly resolved?: 'open' | 'resolved' | 'all';
	readonly author?: string;
}

export interface AnnotecaApi {
	readonly apiVersion: number;
	// The version of the exported assistant guidance, NOT the marker format.
	//
	// It was called `formatVersion` and that name overclaimed. SKILL_SCHEMA_VERSION
	// bumps when the assistant-facing teaching materially changes, which usually
	// but not always tracks the format: v2 was a workflow change (begin-placement,
	// the addressed flow) with no format change behind it. It is also the wrong
	// direction as a guarantee, since a format change that needs no new teaching
	// would not bump it.
	//
	// Annoteca has no independent marker-format version to expose yet. Use this to
	// tell which SKILL.md generation a build ships, not as a compatibility gate on
	// the format itself.
	readonly skillSchemaVersion: number;
	// Async because it has to be. The comment index is populated lazily, from
	// files opened or modified this session, so querying it directly in a fresh
	// session silently returns a fraction of the vault and looks like a correct
	// answer. This awaits the vault scan first, which is the only way the
	// vault-wide promise in the name is true.
	queryComments(filter?: ApiFilter): Promise<readonly ApiComment[]>;
	// Pure over the content it is given: it parses that text rather than reading
	// the vault OR consulting the index, and takes no path for that reason.
	//
	// Both alternatives are wrong here, and the second one subtly. Reading the
	// vault resolves against the stale on-disk copy while the editor shows
	// unsaved edits. Using the index is worse: its marker offsets come from the
	// last rebuild, so combining them with newer content slices the wrong place
	// entirely once an edit lands ahead of a marker, and reports an anchor as
	// missing or as covering the wrong words. Parsing the supplied text is the
	// only version with no stale half.
	anchorsFor(content: string): readonly AnchorRange[];
	// Create comments on this consumer's behalf (F-281).
	//
	// CREATE ONLY, and that is the design. There is no path here to resolve,
	// delete, edit or reply: resolution is a judgement about the writing, and
	// machine tooling does not close a human's thread. A consumer that wants a
	// finding retracted replies to it.
	//
	// Idempotent on `sourceKey`, so a consumer re-running over a note it already
	// promoted creates nothing and gets back only what it made this time. Above
	// the promotion budget the user is asked first, and a refusal returns an
	// empty array rather than throwing: nothing was created, which is exactly
	// what the return value says.
	//
	// Returns only the comments actually written. A stale-read refusal deep in
	// the write path returns empty too, so a consumer that records what it got
	// back can never believe a finding was promoted when it was not.
	promote(
		path: string,
		requests: readonly PromoteRequest[],
	): Promise<readonly CreatedComment[]>;

	// Fires when the comment index changes. Returns its own unsubscribe; a
	// consumer must call it on unload or the callback outlives the consumer.
	onChange(cb: () => void): () => void;
}

// A copy, never the indexed object. The index hands out its live `Comment`
// instances, and a consumer that mutated one would corrupt the vault's view of
// its own comments without touching a byte on disk.
function toApiComment(path: string, c: Comment): ApiComment {
	return {
		id: c.id,
		path,
		category: c.category,
		body: c.body,
		author: c.author,
		date: c.date,
		resolved: c.resolution !== undefined,
		addressed: c.addressed !== undefined,
		replyCount: c.replies.length,
		anchor: c.anchor
			? { text: c.anchor.text, truncated: c.anchor.truncated }
			: undefined,
		marker: { start: c.marker.start, end: c.marker.end },
	};
}

export function createApi(plugin: AnnotecaPlugin): AnnotecaApi {
	return {
		apiVersion: API_VERSION,
		skillSchemaVersion: SKILL_SCHEMA_VERSION,

		async queryComments(
			filter?: ApiFilter,
		): Promise<readonly ApiComment[]> {
			// Both calls, matching the drift check. scanVaultIfNeeded is one-shot
			// and cannot promise the index knows the vault as it is NOW; files
			// added since it ran are picked up by indexUnseenFiles.
			await plugin.scanVaultIfNeeded();
			await plugin.indexUnseenFiles();
			const located = plugin.commentIndex.queryUnresolved({
				paths: filter?.paths ? new Set(filter.paths) : undefined,
				categories: filter?.categories
					? new Set(filter.categories)
					: undefined,
				resolved: filter?.resolved ?? 'open',
				author: filter?.author,
			});
			return located.map((l) => toApiComment(l.path, l.comment));
		},

		anchorsFor(content: string): readonly AnchorRange[] {
			// parseDocument, not parseAll, for the same reason the index uses it:
			// under end-of-file storage the inline marker is lean and the anchor
			// lives in the store at the bottom of the file, so parseAll alone
			// returns a comment whose anchor is undefined and every eof comment
			// silently vanishes from this list. A file with no store entries
			// parses identically either way.
			//
			// Parsed from the supplied text, never from the index. The index
			// holds offsets from its last rebuild, and an unsaved edit before a
			// marker moves every offset after it.
			const out: AnchorRange[] = [];
			for (const c of parseDocument(content).comments) {
				const anchor = c.anchor;
				if (!anchor || anchor.text.length === 0) {
					continue;
				}
				// The same two windows the editor decorations slice, so the
				// ranges this returns are the ones a reader sees underlined
				// rather than a second, subtly different answer.
				const backStart = Math.max(0, c.marker.start - ANCHOR_WINDOW);
				const range = resolveAnchorRangeInWindows(
					content.slice(backStart, c.marker.start),
					backStart,
					c.marker.start,
					content.slice(
						c.marker.end,
						Math.min(content.length, c.marker.end + ANCHOR_WINDOW),
					),
					c.marker.end,
					anchor.text,
				);
				if (range) {
					out.push({
						start: range.from,
						end: range.to,
						category: c.category,
						resolved: c.resolution !== undefined,
						commentId: c.id,
					});
				}
			}
			return out;
		},

		promote(
			path: string,
			requests: readonly PromoteRequest[],
		): Promise<readonly CreatedComment[]> {
			// Delegated, not reimplemented. comment-service owns every write:
			// the serializer, the queue and the stale-read guard all live there,
			// and contract 4.1 exists because a second writer is how this format
			// has been damaged before.
			return plugin.comments.promote(path, requests);
		},

		onChange(cb: () => void): () => void {
			const ref: EventRef = plugin.events.on('index-changed', cb);
			return () => {
				plugin.events.offref(ref);
			};
		},
	};
}
