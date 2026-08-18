// Mode-aware document parse: reconstruct full comments from a document that may
// store their heavy content inline (today's format) OR in the end-of-file store
// (issue #48, "keep prose clean"). This is the one place the marker grammar
// (parser.ts) and the store (store.ts) meet; each of those stays unaware of the
// other, and the join between them lives here.
//
// THE JOIN IS BY id, AND MODE IS DETECTED, NOT DECLARED. A lean marker carries
// only category + id at the passage; its body, replies, resolution, addressed
// state and preserved original live in a store entry keyed by that id. So parsing
// does not need a global "mode" flag: a marker whose id matches a store entry is
// reconstructed from the store, and a marker with inline content is left exactly
// as parser.ts read it. A file with no store entries parses identically to
// parseAll, which is what keeps inline notes byte-for-byte unchanged.
//
// A LEAN MARKER IS JUST AN EMPTY-BODIED MARKER. It serializes as
// `<!-- annoteca/<category>: [id=<id>] -->` — the current grammar with an empty
// body and an id line, so MARKER_RE, scanMarkers and the nested-opener guard are
// untouched. What makes it "lean" is the absence of any inline heavy content, not
// a new marker shape.

import type { Comment, StorageMode } from './types';
import { parseAll } from './parser';
import {
	parseStore,
	type LocatedStoreEntry,
	type StoredComment,
} from './store';

export interface ParsedDocument {
	// One entry per marker, in document order. A lean marker with a matching store
	// entry is merged; every other marker is returned exactly as parser.ts read
	// it, so inline comments are untouched.
	comments: Comment[];
	// Store entries no lean marker consumed: the marker and its prose were deleted
	// but the entry was left behind. Surfaced for the diagnostics layer; not
	// returned as comments, because a stranded entry has no position in the prose.
	orphanedStore: LocatedStoreEntry[];
}

// A marker is lean when it carries no inline heavy content at all — only category
// and id. Everything else moves to the store in eof mode, so a marker that still
// has a body, a reply, an anchor, a date, an author, an addressed/resolution
// state, or a carried unknown line is an INLINE marker and must never be
// overridden by a store entry: doing so could hide visible text behind a stale or
// stray entry. Gating the merge on leanness is what makes "a note never mixes
// styles" safe even when a file does.
function isLeanMarker(c: Comment): boolean {
	return (
		c.body === '' &&
		c.replies.length === 0 &&
		c.addressed === undefined &&
		c.resolution === undefined &&
		c.anchor === undefined &&
		c.date === undefined &&
		c.author === undefined &&
		c.unknownLines.length === 0
	);
}

// Fill a lean marker with its store entry. The marker is authoritative for
// category (it is what the editor decorations render, and it is the copy grep
// finds at the passage) and for the byte range in the prose; the store supplies
// everything the lean marker dropped. The id is shared — it is the join key — so
// either source is correct for it.
function merge(marker: Comment, stored: StoredComment): Comment {
	return {
		id: stored.id,
		category: marker.category,
		body: stored.body,
		date: stored.date,
		author: stored.author,
		anchor: stored.anchor,
		replies: stored.replies.slice(),
		addressed: stored.addressed,
		resolution: stored.resolution,
		unknownLines: stored.unknownLines ? stored.unknownLines.slice() : [],
		marker: marker.marker,
	};
}

// What a mutation needs to persist a change to a comment stored in eof mode: the
// merged full comment (the state a transition must act on, not the lean marker's
// empty shell), the comment's own store entry, and every store entry in file
// order so the persist funnel can rebuild the whole region while touching only
// this one.
export interface EofTarget {
	full: Comment;
	entry: LocatedStoreEntry;
	// File order, orphans included. A mutation rebuilds the region from this list
	// with only `entry` replaced or dropped, so a stranded entry another marker no
	// longer points at is preserved for diagnostics rather than swept by an
	// unrelated write.
	allEntries: LocatedStoreEntry[];
}

// Decide, for one comment the caller has already found fresh in the current text,
// whether it is stored in eof mode, and if so hand back the store context a write
// needs. `rawMarker` is that comment exactly as parseAll read it, so its inline
// content (or absence of it) is what the leanness test reads.
//
// Returns undefined — meaning "stored inline, use the marker path" — when the
// marker has no id, still carries inline content, or has no store entry to join
// (a dangling lean marker, left to the inline path until diagnostics adopts it).
// Only re-parses the store; the caller already parsed the markers to identify
// `rawMarker`, so this adds one cheap scan, not a second full document parse.
export function resolveEofTarget(
	content: string,
	rawMarker: Comment,
): EofTarget | undefined {
	if (rawMarker.id === undefined) return undefined;
	if (!isLeanMarker(rawMarker)) return undefined;
	const allEntries = parseStore(content);
	// First-wins on a duplicate id, matching the marker walk and parseDocument's
	// own join; the write path never emits a duplicate.
	const entry = allEntries.find((e) => e.comment.id === rawMarker.id);
	if (entry === undefined) return undefined;
	return { full: merge(rawMarker, entry.comment), entry, allEntries };
}

export function parseDocument(content: string): ParsedDocument {
	const markers = parseAll(content);
	const storeEntries = parseStore(content);

	// Index by id for the join. On a duplicate id (degenerate — the write path
	// never emits one), the first in file order is the merge candidate, matching
	// the marker walk's own first-wins rule; the later duplicate falls through to
	// the orphan list, where diagnostics can see it.
	const storeById = new Map<string, LocatedStoreEntry>();
	for (const entry of storeEntries) {
		if (!storeById.has(entry.comment.id)) {
			storeById.set(entry.comment.id, entry);
		}
	}

	// Tracked by entry identity, not id, so a duplicate entry that was NOT the
	// merge candidate is still reported as an orphan rather than silently dropped.
	const mergedEntries = new Set<LocatedStoreEntry>();

	const comments = markers.map((marker) => {
		if (marker.id === undefined) return marker;
		const entry = storeById.get(marker.id);
		if (entry === undefined) return marker;
		// An inline marker that happens to share an id keeps its inline content;
		// the store entry becomes an orphan rather than overriding visible text.
		if (!isLeanMarker(marker)) return marker;
		mergedEntries.add(entry);
		return merge(marker, entry.comment);
	});

	const orphanedStore = storeEntries.filter(
		(entry) => !mergedEntries.has(entry),
	);
	return { comments, orphanedStore };
}

// STORAGE-MODE RESOLUTION FOR NEW WORK (issue #48, §5.2.1 of the design).
//
// The mode setting is a default for NEW comments, never a vault-wide rewrite. A
// note's own on-disk format always wins for that note, so one note never mixes
// styles and changing the default (or a per-note override) rewrites nothing that
// already exists. Moving an existing note between modes is the deliberate,
// backup-first convert command, not a side effect of a setting change.

// What format a note's comments are ALREADY stored in. `empty` means the note has
// no comments yet, so its mode is not yet decided and the desired mode applies.
type NoteStorageState = 'inline' | 'eof' | 'empty';

// A note is in eof mode iff at least one lean marker is joined to a store entry.
// An inline marker (one that still carries content) does not count, and neither
// does an orphaned store entry (no marker points at it): both are handled by the
// inline path. A dangling lean marker (no entry to join) is not eof either: it is
// a degenerate empty-bodied inline marker, left to the inline path until
// diagnostics adopts it. With no markers at all, the note has no comments, so the
// desired mode is free to apply even if stranded store entries remain.
function classifyNoteStorage(content: string): NoteStorageState {
	const markers = parseAll(content);
	if (markers.length === 0) return 'empty';
	const storeIds = new Set(parseStore(content).map((e) => e.comment.id));
	const hasEof = markers.some(
		(m) => m.id !== undefined && isLeanMarker(m) && storeIds.has(m.id),
	);
	return hasEof ? 'eof' : 'inline';
}

// Parse a per-note `annoteca_storage` frontmatter override. The value is
// user-reachable (a hand edit, a template, sync), so it is vetted rather than
// trusted: anything that is not a currently-supported mode string, including the
// designed-but-unshipped `hybrid`, returns undefined and falls back to the global
// default, which is forward-safe (a value becomes honored the release its mode
// ships).
export function coerceStorageMode(value: unknown): StorageMode | undefined {
	return value === 'inline' || value === 'eof' ? value : undefined;
}

// Decide the storage mode for a comment about to be ADDED to `content`. The order
// is the design's: the note's current on-disk format wins; only when the note has
// no comments yet does the desired mode apply, a per-note override first, then the
// global default. Pure over the document text and the two desired-mode inputs, so
// the composer resolves the override (from frontmatter) and the default (from
// settings) and hands both in.
export function resolveStorageModeForNewComment(
	content: string,
	override: StorageMode | undefined,
	globalDefault: StorageMode,
): StorageMode {
	const current = classifyNoteStorage(content);
	if (current !== 'empty') return current;
	return override ?? globalDefault;
}
