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

import { countWhile } from './span-index';
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
export function blockPrefix(
	content: string,
	lineStart: number,
	start: number,
): { quotes: boolean; bullet: boolean } | undefined {
	const shape = prefixShape(content, lineStart);
	const k = start - lineStart;
	if (k <= shape.plain)
		return { quotes: shape.firstQuote < k, bullet: false };
	if (
		shape.bullet !== undefined &&
		k >= shape.bullet.from &&
		k <= shape.bullet.to
	)
		return { quotes: shape.firstQuote < shape.plain + 1, bullet: true };
	return undefined;
}

// What blockPrefix answers for every lead on one line, worked out in one pass
// over the line's start: a batch asks about many positions on a line, and
// re-reading the lead for each was quadratic on a long line of block syntax.
//
// The rule read lead by lead: spaces and `>` markers, then optionally a bullet
// (`-`, `*`, `+`, or up to nine digits and `.` or `)`) with at least one space
// or tab after it, then spaces, and nothing else. So a lead is one when it
// ends inside the first run of spaces and `>` (`plain` characters long), or,
// when that run is followed by a bullet and a space, inside the spaces after
// the bullet (lengths `bullet.from` to `bullet.to`).
interface PrefixShape {
	plain: number;
	firstQuote: number;
	bullet: { from: number; to: number } | undefined;
}
let shapesFor: string | undefined;
const shapes = new Map<number, PrefixShape>();
function prefixShape(content: string, lineStart: number): PrefixShape {
	if (shapesFor !== content) {
		shapesFor = content;
		shapes.clear();
	}
	const known = shapes.get(lineStart);
	if (known !== undefined) return known;
	const at = (k: number): string => {
		const ch = content.charAt(lineStart + k);
		return ch === '\n' ? '' : ch;
	};
	let i = 0;
	let firstQuote = Infinity;
	for (;;) {
		const ch = at(i);
		if (ch === ' ' || ch === '\t') i += 1;
		else if (ch === '>') {
			if (firstQuote === Infinity) firstQuote = i;
			i += 1;
		} else break;
	}
	const plain = i;
	let after = -1;
	const ch = at(i);
	if (ch === '-' || ch === '*' || ch === '+') after = i + 1;
	else if (ch >= '0' && ch <= '9' && ch !== '') {
		let j = i;
		while (j - i < 9 && at(j) >= '0' && at(j) <= '9' && at(j) !== '')
			j += 1;
		if (at(j) === '.' || at(j) === ')') after = j + 1;
	}
	let bullet: PrefixShape['bullet'];
	if (after !== -1 && (at(after) === ' ' || at(after) === '\t')) {
		let end = after;
		while (at(end) === ' ' || at(end) === '\t') end += 1;
		bullet = { from: after + 1, to: end };
	}
	const shape = { plain, firstQuote, bullet };
	shapes.set(lineStart, shape);
	return shape;
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
	// Nothing here reads the whole line: a batch plans many passages, and on
	// one long line that was quadratic. A heading's `#` run is in the line's
	// first few characters, and blockPrefix looks the line's shape up.
	const { start: lineStart } = lineAround(content, start);
	if (multiline && HEADING_LINE.test(lineHead(content, lineStart)))
		return { at: lineStart, before: '', after: '\n' };

	const prefix = blockPrefix(content, lineStart, start);
	if (!prefix) return { at: start, before: '', after: null };
	const lead = content.slice(lineStart, start);

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
		const prevStart = lineAround(content, lineStart - 1).start;
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

// The start and end (its line break, or the end of the note) of the line
// holding `pos`. Scanned for a note asked about once; for one asked about
// again, as a batch does, the line starts are indexed and looked up.
let lastAsked: string | undefined;
let lineIndex: { content: string; starts: number[] } | undefined;
function lineAround(
	content: string,
	pos: number,
): { start: number; end: number } {
	if (lineIndex?.content !== content && lastAsked === content) {
		const starts = [0];
		for (let i = 0; i < content.length; i++)
			if (content.charAt(i) === '\n') starts.push(i + 1);
		lineIndex = { content, starts };
	}
	lastAsked = content;
	if (lineIndex?.content !== content) {
		const end = content.indexOf('\n', pos);
		return {
			// Not lastIndexOf from -1, which still looks at offset 0, so
			// both branches agree on the line a note's first offset is on.
			start: pos <= 0 ? 0 : content.lastIndexOf('\n', pos - 1) + 1,
			end: end === -1 ? content.length : end,
		};
	}
	const { starts } = lineIndex;
	const lo = countWhile(starts.length, (mid) => (starts[mid] ?? 0) <= pos);
	const next = starts[lo];
	return {
		start: starts[lo - 1] ?? 0,
		end: next === undefined ? content.length : next - 1,
	};
}

// The first characters of the line starting at `lineStart`, enough for
// HEADING_LINE, which reads at most ten.
function lineHead(content: string, lineStart: number): string {
	let end = lineStart;
	while (
		end < content.length &&
		end < lineStart + 16 &&
		content.charAt(end) !== '\n'
	)
		end += 1;
	return content.slice(lineStart, end);
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

let headingEndsFor: string | undefined;
const headingEnds = new Map<number, number>();
export function headingTextEnd(
	content: string,
	at: number,
): number | undefined {
	const { start: lineStart, end: lineEnd } = lineAround(content, at);
	if (!HEADING_LINE.test(lineHead(content, lineStart))) return undefined;
	// The line with trailing whitespace dropped, walked back from its end once
	// per line: a batch asks for the same heading many times.
	if (headingEndsFor !== content) {
		headingEndsFor = content;
		headingEnds.clear();
	}
	const known = headingEnds.get(lineStart);
	if (known !== undefined) return known;
	let end = lineEnd;
	while (end > lineStart && /\s/.test(content.charAt(end - 1))) end -= 1;
	headingEnds.set(lineStart, end);
	return end;
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
		if (lead.trim() !== '' && !blockPrefix(content, lineStart, start))
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
	if (lineEnd < 3 || content.slice(lineEnd - 3, lineEnd) !== '-->')
		return false;
	const opener = content.lastIndexOf('<!--', lineEnd - 3);
	if (opener === -1) return false;
	const openerLine = content.lastIndexOf('\n', opener - 1) + 1;
	return blockPrefix(content, openerLine, opener) !== undefined;
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
	lineStartOf: (pos: number) => number = (pos) =>
		content.lastIndexOf('\n', pos - 1) + 1,
): boolean {
	// Nothing here slices or searches the whole line: a repair asks this of
	// every marker, and many markers sharing one long line made that
	// quadratic. The repair passes a line-start lookup built once.
	const lineStart = lineStartOf(start);
	if (content.slice(start, end).includes('\n')) {
		// A heading's `#` run sits in the line's first few characters.
		let eol = lineStart;
		while (
			eol < content.length &&
			eol < lineStart + 16 &&
			content.charAt(eol) !== '\n'
		)
			eol += 1;
		if (HEADING_LINE.test(content.slice(lineStart, eol))) return true;
	}
	if (!blockPrefix(content, lineStart, start)) return false;
	// Something after it on the line it ends on.
	for (let i = end; i < content.length; i++) {
		const ch = content.charAt(i);
		if (ch === '\n') return false;
		if (!/\s/.test(ch)) return true;
	}
	return false;
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
//
// Planned against the note as it is and applied in one rebuild, rather than
// rebuilding and re-reading the note per marker, which took minutes on a note
// with thousands of old markers. That gives the same result because a move
// reads only the marker's own line and the line above it (back to that
// line's `<!--` when it ends a comment), and a later
// marker's move only writes at or after the end of the line above that later
// marker, which is past an earlier marker and the gap after it. When a later
// move does land in that stretch (two multi-line markers on one heading line,
// or a heading that ends in a multi-line marker above a line that starts with
// one), only the stretch around them is redone one by one, as before.
export function repairMarkerPlacement(content: string): ImportResult {
	const lineStarts = [0];
	for (let i = 0; i < content.length; i++)
		if (content.charAt(i) === '\n') lineStarts.push(i + 1);
	const lineIndex = (pos: number): number => {
		const lo = countWhile(
			lineStarts.length,
			(mid) => (lineStarts[mid] ?? 0) <= pos,
		);
		return lo - 1;
	};
	const lineStartOf = (pos: number): number =>
		lineStarts[lineIndex(pos)] ?? 0;
	const lineEndOf = (pos: number): number => {
		const next = lineStarts[lineIndex(pos) + 1];
		return next === undefined ? content.length : next - 1;
	};
	const markers = parseAll(content)
		.map((c) => c.marker)
		.filter((m) =>
			markerBreaksReadingView(content, m.start, m.end, lineStartOf),
		)
		.sort((a, b) => b.start - a.start);
	// Each marker's moves, or a window of the note to redo one by one. Kept
	// in processing order, so the last one holds the lowest offsets.
	type Edit = { from: number; to: number; insert: string };
	type Unit =
		| { kind: 'moves'; lo: number; hi: number; edits: Edit[] }
		| { kind: 'window'; lo: number; hi: number };
	const units: Unit[] = [];
	const safe = safeLineStarts(content, lineStarts);
	for (const m of markers) {
		const marker = content.slice(m.start, m.end);
		// Only the marker and the spacing it brought (markerRemovalSpan),
		// never a line break: the gap after a marker that ends a heading runs
		// onto the next line, and taking it joined that line to the heading.
		const cut = markerRemovalSpan(content, m.start, m.end);
		// The note around the marker as the one-by-one walk saw it: the line
		// above, the marker's line up to it, then the rest of the line the
		// passage is on, the marker taken out.
		const lineStart = lineStartOf(cut.from);
		// From the line above, or from further up when that line ends an HTML
		// comment: whether it opened its own block depends on the line its
		// `<!--` is on (endsBlockHtml).
		const above = lineStart > 0 ? lineStartOf(lineStart - 1) : 0;
		// The line above as the planner reads it: trimmed of trailing
		// whitespace before asking whether it ends a comment.
		let aboveEnd = lineStart - 1;
		while (aboveEnd > above && /\s/.test(content.charAt(aboveEnd - 1)))
			aboveEnd -= 1;
		const opener =
			aboveEnd >= 3 && content.slice(aboveEnd - 3, aboveEnd) === '-->'
				? content.lastIndexOf('<!--', aboveEnd - 3)
				: -1;
		const from =
			opener !== -1 && opener < above ? lineStartOf(opener) : above;
		const hi = lineEndOf(cut.to);
		// A later move landing at or before the end of what this one takes
		// out would change what this one sees. The two, and anything else in
		// reach, are redone one by one over a window of the note whose ends
		// sit outside every comment and the properties, where the window read
		// alone parses as the whole note does. Only that window is slow.
		const last = units[units.length - 1];
		if (last !== undefined && last.lo <= cut.to) {
			let lo = safe.atOrBefore(from);
			let top = hi;
			for (;;) {
				const u = units[units.length - 1];
				const end = safe.atOrAfter(top);
				if (u === undefined || u.lo >= end) {
					top = end;
					break;
				}
				units.pop();
				top = Math.max(top, u.hi);
				lo = Math.min(lo, safe.atOrBefore(u.lo));
			}
			units.push({ kind: 'window', lo, hi: top });
			continue;
		}
		const view =
			content.slice(from, cut.from) +
			content.slice(cut.to, Math.max(cut.to, hi));
		const plan = planMarkerInsert(
			view,
			cut.from - from,
			marker.includes('\n'),
		);
		const at = from + plan.at;
		// The planned spot can sit inside a multi-line marker above this one,
		// and moving there would corrupt both. Such a marker stays where it
		// is: it renders badly but is whole, which a repair must not change.
		// Asked of the note as it is: nothing at or before this marker has
		// moved, and taking the marker out changes no range that holds a spot
		// before it.
		if (enclosingForbidden(content, at) !== undefined) continue;
		units.push({
			kind: 'moves',
			lo: Math.min(at, cut.from),
			hi,
			edits: [
				{ from: cut.from, to: cut.to, insert: '' },
				{ from: at, to: at, insert: layoutMarker(plan, marker, ' ') },
			],
		});
	}
	const edits: Edit[] = [];
	let moved = 0;
	for (const u of units) {
		if (u.kind === 'moves') {
			edits.push(...u.edits);
			moved += 1;
			continue;
		}
		// Its markers, found by binary search rather than a scan of all of
		// them per window (`markers` runs latest first).
		const first = (pos: number): number => {
			const lo = countWhile(
				markers.length,
				(mid) => (markers[mid]?.start ?? 0) >= pos,
			);
			return lo;
		};
		const inside = markers
			.slice(first(u.hi), first(u.lo))
			.map((m) => ({ start: m.start - u.lo, end: m.end - u.lo }));
		const redone = repairOneByOne(content.slice(u.lo, u.hi), inside);
		edits.push({ from: u.lo, to: u.hi, insert: redone.updated });
		moved += redone.converted;
	}
	// At one offset the insertion goes before the removal that starts there:
	// a marker moved onto its own line lands at its own old start.
	edits.sort((a, b) => a.from - b.from || a.to - a.from - (b.to - b.from));
	let updated = '';
	let at = 0;
	for (const e of edits) {
		updated += content.slice(at, e.from) + e.insert;
		at = e.to;
	}
	updated += content.slice(at);
	return { updated, converted: moved };
}

// Line starts outside every HTML comment and outside the note properties:
// where a stretch of the note can be cut out and parsed alone with the same
// answers as the whole note gives inside it. A comment here runs from any
// `<!--`, escaped or not, to the next `-->`, which covers every range the
// parser reads (markers, closers, store entries, unclosed openers).
export function safeLineStarts(
	content: string,
	lineStarts: readonly number[],
): { atOrBefore: (pos: number) => number; atOrAfter: (pos: number) => number } {
	const properties = frontmatterEnd(content);
	const out: number[] = [];
	let commentEnd = 0;
	let next = content.indexOf('<!--');
	for (const start of lineStarts) {
		while (next !== -1 && next < start) {
			const close = content.indexOf('-->', next + 4);
			commentEnd = close === -1 ? Infinity : close + 3;
			next = content.indexOf('<!--', Math.max(next + 4, commentEnd));
		}
		// Nor a line starting `---`: read alone from there, it would open
		// note properties the note does not have.
		if (
			start >= commentEnd &&
			(start === 0 || start >= properties) &&
			(start === 0 || !content.startsWith('---', start))
		)
			out.push(start);
	}
	const search = (pos: number): number => {
		const lo = countWhile(out.length, (mid) => (out[mid] ?? 0) <= pos);
		return lo;
	};
	return {
		atOrBefore: (pos) => out[search(pos) - 1] ?? 0,
		atOrAfter: (pos) => {
			const k = search(pos - 1);
			return out[k] ?? content.length;
		},
	};
}

// The same moves made one at a time, each against the note as the moves
// before it left it.
function repairOneByOne(
	content: string,
	markers: readonly { start: number; end: number }[],
): ImportResult {
	let updated = content;
	let moved = 0;
	for (const m of markers) {
		const marker = updated.slice(m.start, m.end);
		const cut = markerRemovalSpan(updated, m.start, m.end);
		const without = updated.slice(0, cut.from) + updated.slice(cut.to);
		const plan = planMarkerInsert(without, cut.from, marker.includes('\n'));
		if (enclosingForbidden(without, plan.at) !== undefined) continue;
		updated =
			without.slice(0, plan.at) +
			layoutMarker(plan, marker, ' ') +
			without.slice(plan.at);
		moved += 1;
	}
	return { updated, converted: moved };
}
