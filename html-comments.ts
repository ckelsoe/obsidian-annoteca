// Comments already written inside an HTML comment that is not Annoteca's.
//
// forbidden.ts stops new ones. These are the ones written before it did, or by
// hand, or by an assistant editing the file directly. HTML comments do not
// nest, so the outer comment ends at the marker's own `-->`: the marker still
// reads as a comment, but the rest of the outer comment, and its own `-->`,
// show in the note as text. Anything that reads the outer comment (a script
// building an index from diagram notes, say) gets it cut short, with half a
// marker in it.
//
// The marker itself parses, so findMalformedMarkers cannot see this. It is
// reported alongside those findings, with kind 'malformed': the repair is to
// move the comment, and nothing about it makes removing another comment
// unsafe, which is what the other kinds exist to block.
//
// Pure: no Obsidian dependency.

import {
	findMalformedMarkers,
	scanClosers,
	scanMarkers,
	type MalformedMarker,
} from './parser';
import { htmlCommentRanges } from './range-placement';
import { tableCellProblems } from './table-cells';
import { SpanIndex } from './span-index';

const REASON =
	"This comment is inside another HTML comment, which now ends at this comment's `-->`, so the rest of that HTML comment shows in the note as text. Move this comment, and its range end if it has one, outside the HTML comment.";

export function markersInsideHtmlComments(content: string): MalformedMarker[] {
	const ranges = htmlCommentRanges(content);
	if (ranges.length === 0) return [];
	const index = new SpanIndex(ranges, (r) => r);
	const markers = scanMarkers(content);
	const starts = [
		...markers.map((m) => m.start),
		...scanClosers(content, markers).map((k) => k.start),
	].sort((a, b) => a - b);
	const out: MalformedMarker[] = [];
	for (const start of starts) {
		const r = index.first(start, start);
		if (r === undefined || start <= r.start || start >= r.end) continue;
		out.push({
			start,
			excerpt: content.slice(
				start,
				Math.min(content.length, start + 120),
			),
			reason: REASON,
			kind: 'malformed',
		});
	}
	return out;
}

// Every marker problem in a note: what findMalformedMarkers reports, the
// comments sitting inside an HTML comment, and full markers in table rows
// (table-cells.ts), in document order. What the index
// keeps for the open/save notice, and what "Validate marker format" lists.
export function markerProblems(content: string): MalformedMarker[] {
	return [
		...findMalformedMarkers(content),
		...markersInsideHtmlComments(content),
		...tableCellProblems(content),
	].sort((a, b) => a.start - b.start);
}
