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

import type { Comment } from './types';
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
