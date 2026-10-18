// Where a new marker goes, so the note still renders.
//
// A marker is an HTML comment placed just before the passage it is about.
// Markdown treats a block that STARTS with `<!--` as raw HTML through the end
// of the line holding `-->`, so a marker that opens a paragraph, a wrapped
// line inside one, a list item or a quote left the rest of that line
// unrendered in reading view and exports (no bold, no links), and a second
// marker opening on that line leaked its `[id=...]` lines as visible text. A
// multi-line marker anywhere on a heading line splits the heading. Each case
// was checked in Obsidian's reading view (2026-10-15).
//
// The fix keeps the marker just before its passage but moves it off the start
// of the block:
//   - a paragraph's first line: the marker on its own line above it;
//   - a wrapped line inside a paragraph: the marker at the end of the line
//     before, so the paragraph stays one paragraph;
//   - a list item: the marker after the bullet, the text on the next line,
//     indented to stay in the item;
//   - a quote: the marker after `>`, the text on the next `>` line;
//   - a heading: a multi-line marker on its own line above the heading.
// Anywhere else (text already before it on the line) the marker stays inline.
//
// Pure: no Obsidian dependency.

import { parseAll } from './parser';
import type { ImportResult } from './imports';
import { enclosingForbidden } from './forbidden';
import { frontmatterEnd } from './range-placement';

// What sits between a marker and its passage: the one space an inline marker
// is followed by, or a line break plus the next line's indentation, quote
// markers or heading markers. Returns the offset where the passage starts.
// Every reader of "the text after this marker" goes through this, so a marker
// placed on its own line still finds its passage.
//
// Blank lines after a marker that stands alone on its line are skipped too:
// a formatter that puts blank lines around block HTML (the Obsidian Linter
// does, checked 2026-10-15) separates such a marker from its paragraph
// without changing what it is about.
export function gapEnd(charAt: (pos: number) => string, pos: number): number {
	if (charAt(pos) === ' ') return pos + 1;
	if (charAt(pos) !== '\n') return pos;
	let p = pos + 1;
	const skipSpaces = (): void => {
		while (charAt(p) === ' ' || charAt(p) === '\t') p += 1;
	};
	skipSpaces();
	while (charAt(p) === '\n') {
		p += 1;
		skipSpaces();
	}
	while (charAt(p) === '>') {
		p += 1;
		skipSpaces();
	}
	if (charAt(p) === '#') {
		let q = p;
		while (charAt(q) === '#' && q - p < 6) q += 1;
		if (charAt(q) === ' ' || charAt(q) === '\t') p = q + 1;
	}
	return p;
}

const HEADING_LINE = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
// Text before the passage that is nothing but block syntax: indentation,
// quote markers, and an optional list bullet or number (no task box: after
// `- [ ] ` the item's text already starts with the box, so a marker there is
// inline). Undefined when there is anything else. Scanned by hand: the regex
// for this backtracks badly on long runs of spaces.
function blockPrefix(
	lead: string,
): { quotes: boolean; bullet: boolean } | undefined {
	let i = 0;
	const spaces = (): void => {
		while (lead[i] === ' ' || lead[i] === '\t') i += 1;
	};
	spaces();
	let quotes = false;
	while (lead[i] === '>') {
		quotes = true;
		i += 1;
		spaces();
	}
	let bullet = false;
	const ch = lead[i];
	if (ch === '-' || ch === '*' || ch === '+') {
		bullet = true;
		i += 1;
	} else if (ch !== undefined && ch >= '0' && ch <= '9') {
		let j = i;
		const digit = (k: number): boolean =>
			lead.charAt(k) >= '0' && lead.charAt(k) <= '9' && k < lead.length;
		while (j - i < 9 && digit(j)) j += 1;
		if (lead[j] === '.' || lead[j] === ')') {
			bullet = true;
			i = j + 1;
		}
	}
	if (bullet) {
		// A bullet needs a space after it, or it is text.
		if (lead[i] !== ' ' && lead[i] !== '\t') return undefined;
		spaces();
	}
	return i === lead.length ? { quotes, bullet } : undefined;
}
const BREAKS_PARAGRAPH =
	/^(?:[ \t]{0,3}(?:#{1,6}(?:[ \t]|$)|```|~~~|[-*_][ \t]*[-*_][ \t]*[-*_])|\s*\|)/;

export interface MarkerInsert {
	// Where the inserted text goes.
	readonly at: number;
	// Inserted before the marker, and after it. `after` is null for an inline
	// marker, where the caller decides (a selection gets one space, a bare
	// cursor none).
	readonly before: string;
	readonly after: string | null;
}

// How to insert a marker for a passage starting at `start`. `multiline`: the
// marker spans lines (an inline-storage marker does; an end-of-file lean
// marker does not), which only matters on a heading.
export function planMarkerInsert(
	content: string,
	start: number,
	multiline: boolean,
): MarkerInsert {
	const lineStart = content.lastIndexOf('\n', start - 1) + 1;
	const lineEndIdx = content.indexOf('\n', start);
	const line = content.slice(
		lineStart,
		lineEndIdx === -1 ? content.length : lineEndIdx,
	);
	if (multiline && HEADING_LINE.test(line))
		return { at: lineStart, before: '', after: '\n' };

	const lead = content.slice(lineStart, start);
	const prefix = blockPrefix(lead);
	if (!prefix) return { at: start, before: '', after: null };

	if (prefix.bullet) {
		// Continuation lines are indented to the item's text, the bullet
		// becoming spaces; quote markers in front of it stay.
		const cont = lead.replace(/(?:[-*+]|\d{1,9}[.)])(?=[ \t])/, (b) =>
			' '.repeat(b.length),
		);
		return { at: start, before: '', after: `\n${cont}` };
	}
	if (prefix.quotes) return { at: start, before: '', after: `\n${lead}` };

	// A plain line. Inside a paragraph (the line before has text and does not
	// end the paragraph) the marker goes to the end of that line: a line
	// starting with `<!--` would cut the paragraph in two. Before the end of
	// any trailing spaces, so a hard line break there survives.
	if (lineStart > 0) {
		const prevStart = content.lastIndexOf('\n', lineStart - 2) + 1;
		const prev = content.slice(prevStart, lineStart - 1);
		if (
			prev.trim() !== '' &&
			!BREAKS_PARAGRAPH.test(prev) &&
			!endsBlockHtml(content, prevStart + prev.trimEnd().length)
		) {
			const at = prevStart + prev.trimEnd().length;
			return { at, before: ' ', after: '' };
		}
	}
	return { at: start, before: '', after: `\n${lead}` };
}

// The end of the heading text when `at` is on a heading line, else
// undefined. A multi-line marker on a heading goes on its own line above it,
// so a comment made on part of a heading covers the whole heading: its range
// would otherwise start at the heading's first word whatever was selected.
// The later of `end` and the heading end, when `at` is on a heading line: a
// selection that runs past the heading keeps its own end.
export function headingRangeEnd(
	content: string,
	at: number,
	end: number,
): number {
	return Math.max(end, headingTextEnd(content, at) ?? end);
}

export function headingTextEnd(
	content: string,
	at: number,
): number | undefined {
	const lineStart = content.lastIndexOf('\n', at - 1) + 1;
	const lineEndIdx = content.indexOf('\n', at);
	const lineEnd = lineEndIdx === -1 ? content.length : lineEndIdx;
	const line = content.slice(lineStart, lineEnd);
	if (!HEADING_LINE.test(line)) return undefined;
	return lineStart + line.trimEnd().length;
}

// What to take out of `content` to remove the marker at [start, end), and only
// what its placement added: the one space after an inline marker, the space
// before one appended to the previous line, or the line break and the
// continuation prefix after one on its own line. Never the passage's own
// syntax (a heading's `#`, a quote's `>` that was there before).
export function markerRemovalSpan(
	content: string,
	start: number,
	end: number,
): { from: number; to: number } {
	const next = content.charAt(end);
	if (next === ' ') return { from: start, to: end + 1 };
	if (next === '\n') {
		const lineStart = content.lastIndexOf('\n', start - 1) + 1;
		const lead = content.slice(lineStart, start);
		if (lead.trim() !== '' && !blockPrefix(lead))
			return content.charAt(start - 1) === ' '
				? { from: start - 1, to: end }
				: { from: start, to: end };
		// On its own line (after a bullet or `>` at most): the line break goes,
		// and the next line's continuation prefix, which only repeats `lead`.
		let k = end + 1;
		while (
			k - (end + 1) < lead.length &&
			(content.charAt(k) === ' ' ||
				content.charAt(k) === '\t' ||
				content.charAt(k) === '>')
		)
			k += 1;
		return { from: start, to: k };
	}
	return { from: start, to: end };
}

// Whether the text ending at `lineEnd` ends with an HTML comment that opened
// its own block (an earlier marker placed above this paragraph, or alone after
// a bullet). That line ends a raw HTML block, not a paragraph line, so a marker
// appended to it would continue the block and show its own lines as text.
function endsBlockHtml(content: string, lineEnd: number): boolean {
	if (!content.slice(0, lineEnd).endsWith('-->')) return false;
	const opener = content.lastIndexOf('<!--', lineEnd - 3);
	if (opener === -1) return false;
	const openerLine = content.lastIndexOf('\n', opener - 1) + 1;
	return blockPrefix(content.slice(openerLine, opener)) !== undefined;
}

// The text to splice for a marker: `marker` laid out per the plan, with
// `inline` as the separator an inline marker gets.
export function layoutMarker(
	plan: MarkerInsert,
	marker: string,
	inline: string,
): string {
	return `${plan.before}${marker}${plan.after ?? inline}`;
}

// Whether a marker already in a note is one of the shapes above that break
// reading view: a multi-line marker on a heading line, or a marker that opens
// its block line with text after it on the same line.
export function markerBreaksReadingView(
	content: string,
	start: number,
	end: number,
): boolean {
	const text = content.slice(start, end);
	const lineStart = content.lastIndexOf('\n', start - 1) + 1;
	const lineEndIdx = content.indexOf('\n', start);
	const line = content.slice(
		lineStart,
		lineEndIdx === -1 ? content.length : lineEndIdx,
	);
	if (text.includes('\n') && HEADING_LINE.test(line)) return true;
	if (!blockPrefix(content.slice(lineStart, start))) return false;
	// Something after it on the line it ends on.
	const afterEnd = content.indexOf('\n', end);
	const rest = content.slice(
		end,
		afterEnd === -1 ? content.length : afterEnd,
	);
	return rest.trim() !== '';
}

// planMarkerInsert, kept out of every place a marker must not go (another
// marker, a closer, a store entry, the note properties; see forbidden.ts).
// Placement moves a marker off the start of its block, and that move can carry
// it into a multi-line marker above; so can a start that was already inside
// one. Either way it goes just before what it landed in, which splits nothing,
// or just after the properties, since nothing may go before them. Undefined
// only if no such place settles, which the bounded loop guards against rather
// than expects: every step but the properties one moves strictly backwards.
export function planSafeMarkerInsert(
	content: string,
	start: number,
	multiline: boolean,
): MarkerInsert | undefined {
	const properties = frontmatterEnd(content);
	let place = planMarkerInsert(content, start, multiline);
	for (let step = 0; step < 64; step++) {
		const inside = enclosingForbidden(content, place.at);
		if (inside === undefined) {
			// Right after properties that end the note with no line break,
			// the marker would share the closing `---` line, and the
			// properties would stop being properties. Its own line instead.
			if (
				properties > 0 &&
				place.at === properties &&
				content.charAt(properties - 1) !== '\n'
			)
				return { ...place, before: `\n${place.before}` };
			return place;
		}
		// Only the properties send it forward. A marker that opens the note
		// also starts at 0, and before it is exactly where this one belongs.
		const next =
			properties > 0 && inside.start === 0 && inside.end === properties
				? inside.end
				: inside.start;
		place = planMarkerInsert(content, next, multiline);
	}
	return undefined;
}

// Move every marker that breaks reading view to where planMarkerInsert would
// have put it. The comment and its text are unchanged; only the marker's
// position relative to the line moves. Latest first, so earlier offsets stay
// valid.
export function repairMarkerPlacement(content: string): ImportResult {
	const markers = parseAll(content)
		.map((c) => c.marker)
		.filter((m) => markerBreaksReadingView(content, m.start, m.end))
		.sort((a, b) => b.start - a.start);
	let updated = content;
	let moved = 0;
	for (const m of markers) {
		const marker = updated.slice(m.start, m.end);
		const passage = gapEnd((p) => updated.charAt(p), m.end);
		const without = updated.slice(0, m.start) + updated.slice(passage);
		const plan = planMarkerInsert(without, m.start, marker.includes('\n'));
		// The planned spot can sit inside a multi-line marker above this one,
		// and moving there would corrupt both. Such a marker stays where it
		// is: it renders badly but is whole, which a repair must not change.
		if (enclosingForbidden(without, plan.at) !== undefined) continue;
		updated =
			without.slice(0, plan.at) +
			layoutMarker(plan, marker, ' ') +
			without.slice(plan.at);
		moved += 1;
	}
	return { updated, converted: moved };
}
