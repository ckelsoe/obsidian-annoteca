// Where a new marker or closer must never be written, and where to put one
// that would land there. Pure (no Obsidian dependency), so the placement code
// in marker-placement.ts and every writer in comment-service.ts, the composer
// and the importer can share one definition instead of drifting apart.

import { parseAll, scanClosers, unclosedOpenerRanges } from './parser';
import { frontmatterEnd } from './range-placement';
import { SpanIndex } from './span-index';
import { scanStoreEntries } from './store';

// Byte ranges a promoted marker must never be spliced into: existing markers,
// end-of-file store blocks, closers, the span an unclosed opener hides, and
// YAML frontmatter.
//
// Bounds alone are not enough. An offset inside an existing marker is in bounds
// and splices a new marker into the middle of that one, which is the exact
// damage `findMalformedMarkers` exists to report after the fact. A consumer
// computing offsets over raw markdown reaches this honestly: Plumbline masks
// markers before linting, and a bug in that masking would arrive here as a
// perfectly well-formed request.
export function forbiddenRanges(
	content: string,
): { start: number; end: number }[] {
	return forbiddenKinds(content).flat();
}

// forbiddenRanges by kind, in its order: markers, store entries, closers,
// unclosed openers, the properties. Each kind is in document order.
function forbiddenKinds(content: string): { start: number; end: number }[][] {
	const markers = parseAll(content).map((c) => ({
		start: c.marker.start,
		end: c.marker.end,
	}));
	const stores = scanStoreEntries(content).map((e) => ({
		start: e.start,
		end: e.end,
	}));
	// Range closers (#84), for the same reason as markers: a marker spliced
	// into the middle of one breaks it, and its comment silently loses its end.
	const closers = scanClosers(content).map((k) => ({
		start: k.start,
		end: k.end,
	}));
	// A marker opener with no `-->` of its own: everything from it to the next
	// `-->` (or the end of the note) is inside an open HTML comment, so a
	// marker written there is hidden and its `-->` closes the stray opener.
	// One that runs to the end of the note covers the end too: a marker
	// appended there is still inside it. One inside the properties hides
	// nothing, since they are not rendered as HTML, and counting it would
	// close off the whole note below them.
	const properties = frontmatterEnd(content);
	const unclosed = unclosedOpenerRanges(content)
		.filter((r) => r.start >= properties)
		.map((r) =>
			r.end === content.length ? { start: r.start, end: r.end + 1 } : r,
		);
	// Frontmatter, only when the document opens with it. A `---` fence anywhere
	// else is a horizontal rule and is ordinary prose.
	const fm = properties > 0 ? [{ start: 0, end: properties }] : [];
	return [markers, stores, closers, unclosed, fm];
}

// Whether a new marker placed at `offset` would land strictly inside one of
// the forbidden ranges. Either edge is fine: a marker right before or right
// after another one splits nothing. The composer asks this before it writes,
// the same rule the API and the reading view already apply.
export function insideForbidden(content: string, offset: number): boolean {
	return enclosingForbidden(content, offset) !== undefined;
}

// The forbidden range `offset` falls strictly inside, if any. The note
// properties are the exception to "either edge is fine": a marker at offset 0
// goes in front of the opening `---`, and the properties stop being
// properties, so the start of the frontmatter counts as inside it.
export function enclosingForbidden(
	content: string,
	offset: number,
): { start: number; end: number } | undefined {
	const fm = frontmatterEnd(content);
	if (fm > 0 && offset < fm) return { start: 0, end: fm };
	// The first range in forbiddenRanges' order that holds it, as a find over
	// that list answered: the first kind with one, and within a kind the
	// first in document order. Indexed, and kept for the last note asked
	// about: a batch of promoted comments and the nested-comment repair ask
	// this for one note many times, and rebuilding the list each time was
	// quadratic.
	for (const index of forbiddenIndexes(content)) {
		const r = index.first(offset, offset);
		if (r !== undefined) return { start: r.start, end: r.end };
	}
	return undefined;
}

type Range = { start: number; end: number };
let lastIndexes: { content: string; indexes: SpanIndex<Range>[] } | undefined;
function forbiddenIndexes(content: string): SpanIndex<Range>[] {
	if (lastIndexes?.content !== content)
		lastIndexes = {
			content,
			indexes: forbiddenKinds(content).map(
				(kind) => new SpanIndex(kind, (r) => r),
			),
		};
	return lastIndexes.indexes;
}
