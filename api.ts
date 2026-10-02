import { TFile, type EventRef } from 'obsidian';

import type AnnotecaPlugin from './main';
import type { Comment, CreatedComment, PromoteRequest } from './types';
import { parseDocument } from './document';
import {
	ANCHOR_WINDOW,
	rangeSpan,
	resolveAnchorRangeInWindows,
} from './view-utils';
import { resolveSettingsCategories } from './settings';
import { forbiddenRanges } from './comment-service';

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

// The number is a capability floor a consumer can gate on, and it moves when a
// method consumers are expected to gate on lands. A consumer still feature-detects
// the exact method it calls: additive helpers ride alongside a gated method without
// their own bump (categories() shipped with promote() and did not move the number),
// and a new field on a returned object never moves it (AnchorRange.addressed did not).
//
// 1 = read only: queryComments, anchorsFor, onChange.
// 2 = adds promote(). Bumped because a consumer checking `apiVersion` to decide
//     whether it can promote would otherwise treat a read-only build and this one
//     as the same thing and call a method that is not there.
// 3 = adds reveal(). Bumped for the same reason: a consumer checking `apiVersion`
//     before it wires a "jump to this comment" action must be able to tell a build
//     that has reveal() from one that does not.
// 5 = adds compose(): a companion can ask the USER to comment on a range,
//     through Annoteca's own form. Bumped because a consumer wiring a
//     "comment on this" action has to know the method is there.
// 4 = promote() takes `closeRange` and reports `closed` (#84). Nothing existing
//     changed shape: the request field is optional and the result field is new,
//     and an older build ignores the request field. Bumped anyway because a
//     consumer deciding whether to ask for ranges should not have to promote a
//     comment to find out it cannot get one.
export const API_VERSION = 5;

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
// The text a compose() call asks the user to comment on, as editor offsets.
export interface ComposeRange {
	readonly start: number;
	readonly end: number;
}

export interface AnchorRange {
	readonly start: number;
	readonly end: number;
	readonly category: string;
	readonly resolved: boolean;
	// A proposed edit is sitting in the note awaiting accept, revise or reject.
	// Such a comment is NOT resolved, so `resolved` alone cannot tell the two
	// apart, and a consumer that yields to open comments needs to: interop
	// contract 5.1 has a prose linter suppress its underline under an open
	// comment but NOT under an addressed one, because that passage is back in
	// play and worth checking again.
	//
	// Additive: added after apiVersion 2 without bumping it, because a new field
	// on a returned object breaks no existing consumer. A consumer that wants it
	// should feature-detect rather than assume a version.
	readonly addressed: boolean;
	readonly commentId: string | undefined;
}

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

export interface AnnotecaApi {
	readonly apiVersion: number;
	// Async because it has to be. The comment index is populated lazily, from
	// files opened or modified this session, so querying it directly in a fresh
	// session silently returns a fraction of the vault and looks like a correct
	// answer. This awaits the vault scan first, which is the only way the
	// vault-wide promise in the name is true.
	// The categories a comment may be created in, in the user's own order, with
	// their display names.
	//
	// Exposed because a consumer that creates comments has to offer a choice, and
	// the alternative is hardcoding this list on the other side of a repo
	// boundary, where it drifts the first time the user adds or renames one.
	// Copies, and resolved through the same path the composer uses, so a consumer
	// sees exactly the set the user sees.
	categories(): readonly ApiCategory[];
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
	// machine tooling does not close a human's thread. If a finding needs
	// retracting, the user replies to it by hand; this API has no reply.
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
	// `expected` is the note's editor text the anchors were computed against, the
	// same text passed to anchorsFor. Promotion is queued behind any write already in
	// flight for that path, so by the time it runs the note may have moved on;
	// this refuses rather than placing markers at offsets that no longer mean
	// what the consumer meant. A refusal returns an empty array, and re-reading
	// and calling again is the correct response.
	promote(
		path: string,
		requests: readonly PromoteRequest[],
		expected: string,
	): Promise<readonly CreatedComment[]>;

	// Open the note holding a comment, scroll to it, and open its thread. For a
	// consumer that draws its own indicator (a mindmap node badge, a bookmark
	// row) and wants a click to land the reader on the comment.
	//
	// Read and navigate only: it never writes. Resolves `false` when no indexed
	// file carries that id, so a caller can fall back rather than assume the jump
	// worked; the comment may have been deleted since the caller read it. The
	// vault is warmed the same way queryComments warms it, so a fresh session
	// reveals a comment in a note nobody has opened yet.
	reveal(commentId: string): Promise<boolean>;

	// Ask the user to comment on exactly [start, end) of a note (apiVersion 5).
	// Opens the note, selects that text and opens Annoteca's own comment form,
	// so the comment is the USER's: their author tag, their words, and a
	// closing marker so it covers exactly that text. Built for a companion that
	// shows notes another way (a mind map node, an outline row) and wants a
	// "comment on this" action. Nothing is written until the user saves.
	//
	// Offsets are into the note's editor text, the same text anchorsFor takes.
	// Resolves false, opening nothing, for a path that is not a markdown note,
	// a range that is empty, out of bounds, or starts or ends inside an
	// existing comment marker, closer, store block or the note properties.
	compose(path: string, range: ComposeRange): Promise<boolean>;

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

		categories(): readonly ApiCategory[] {
			// Narrowed to id and name. The internal definition also carries an
			// icon and a colour, which are this plugin's rendering concern and
			// would become things this API can never change.
			return resolveSettingsCategories(plugin.settings).map((c) => ({
				id: c.id,
				displayName: c.displayName,
			}));
		},

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
				// A range comment (#84) carries its exact extent in the file,
				// so it is reported from that rather than from anchor matching,
				// which loses a passage longer than the anchor window or one
				// that crosses a line break.
				// Gated on the closer, not on the span: a range whose text was
				// deleted has no span, and falling through to anchor matching
				// would then report whatever matching text precedes the marker,
				// which is not the comment's passage. The editor draws nothing
				// there, and this agrees with it.
				if (c.closer) {
					const span = rangeSpan(c, (pos) => content.charAt(pos));
					if (!span) continue;
					out.push({
						start: span.from,
						end: span.to,
						category: c.category,
						resolved: c.resolution !== undefined,
						addressed: c.addressed !== undefined,
						commentId: c.id,
					});
					continue;
				}
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
						addressed: c.addressed !== undefined,
						commentId: c.id,
					});
				}
			}
			return out;
		},

		promote(
			path: string,
			requests: readonly PromoteRequest[],
			expected: string,
		): Promise<readonly CreatedComment[]> {
			// Delegated, not reimplemented. comment-service owns every write:
			// the serializer, the queue and the stale-read guard all live there,
			// and contract 4.1 exists because a second writer is how this format
			// has been damaged before.
			return plugin.comments.promote(path, requests, expected);
		},

		async compose(path: string, range: ComposeRange): Promise<boolean> {
			// A runtime API: the declared types are documentation, not a
			// guarantee, so every input is checked before anything opens.
			const input: unknown = range;
			if (typeof path !== 'string') return false;
			if (typeof input !== 'object' || input === null) return false;
			const { start, end } = input as { start: unknown; end: unknown };
			if (
				typeof start !== 'number' ||
				typeof end !== 'number' ||
				!Number.isInteger(start) ||
				!Number.isInteger(end) ||
				start < 0 ||
				end <= start
			)
				return false;
			const file = plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || file.extension !== 'md')
				return false;
			const note = await plugin.comments.currentNoteText(path, file);
			if (end > note.text.length) return false;
			// The same zones promote() refuses: a selection that starts or ends
			// inside a marker, closer, store block or the properties would put
			// the new marker or closer inside existing syntax.
			const inside = (pos: number): boolean =>
				forbiddenRanges(note.text).some(
					(f) => pos > f.start && pos < f.end,
				);
			if (inside(start) || inside(end)) return false;
			return plugin.commentOnRange(path, start, end);
		},

		async reveal(commentId: string): Promise<boolean> {
			// The same warm-up queryComments does: the index is populated lazily
			// from files touched this session, so a fresh session would miss a
			// comment in a note nobody has opened. scanVaultIfNeeded is one-shot;
			// indexUnseenFiles catches files added since it ran.
			await plugin.scanVaultIfNeeded();
			await plugin.indexUnseenFiles();
			const located = plugin.commentIndex.locateById(commentId);
			if (!located) return false;
			// Delegated to the plugin's own navigation, so a consumer's jump lands
			// exactly where a hub click does: the marker scrolled into view and the
			// reviewer opened on the comment. The marker start, not the anchor: the
			// marker is what the editor decorations and the reviewer key on.
			await plugin.navigateToComment(
				located.path,
				located.comment.marker.start,
				located.comment,
			);
			return true;
		},

		onChange(cb: () => void): () => void {
			const ref: EventRef = plugin.events.on('index-changed', cb);
			return () => {
				plugin.events.offref(ref);
			};
		},
	};
}
