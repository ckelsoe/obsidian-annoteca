// Where a new marker or closer must never be written, and where to put one
// that would land there. Pure (no Obsidian dependency), so the placement code
// in marker-placement.ts and every writer in comment-service.ts, the composer
// and the importer can share one definition instead of drifting apart.

import { parseAll, scanClosers, unclosedOpenerRanges } from './parser';
import { frontmatterEnd } from './range-placement';
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
	const out = parseAll(content).map((c) => ({
		start: c.marker.start,
		end: c.marker.end,
	}));
	for (const e of scanStoreEntries(content)) {
		out.push({ start: e.start, end: e.end });
	}
	// Range closers (#84), for the same reason as markers: a marker spliced
	// into the middle of one breaks it, and its comment silently loses its end.
	for (const k of scanClosers(content)) {
		out.push({ start: k.start, end: k.end });
	}
	// A marker opener with no `-->` of its own: everything from it to the next
	// `-->` (or the end of the note) is inside an open HTML comment, so a
	// marker written there is hidden and its `-->` closes the stray opener.
	// One that runs to the end of the note covers the end too: a marker
	// appended there is still inside it. One inside the properties hides
	// nothing, since they are not rendered as HTML, and counting it would
	// close off the whole note below them.
	const properties = frontmatterEnd(content);
	for (const r of unclosedOpenerRanges(content)) {
		if (r.start < properties) continue;
		out.push(
			r.end === content.length ? { start: r.start, end: r.end + 1 } : r,
		);
	}
	// Frontmatter, only when the document opens with it. A `---` fence anywhere
	// else is a horizontal rule and is ordinary prose.
	if (properties > 0) out.push({ start: 0, end: properties });
	return out;
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
	return forbiddenRanges(content).find(
		(r) => offset > r.start && offset < r.end,
	);
}
