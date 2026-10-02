// The sentence around the cursor (#84 open question): what "Add comment for
// current sentence" selects before it opens the composer, so the comment covers
// exactly that sentence. Pure over the note's editor text, so it is testable
// without an editor.
//
// Text, not grammar. A sentence ends at `.`, `!`, `?` or `…` followed by
// whitespace or the end of the paragraph, with any closing quotes or brackets
// kept inside it. A sentence never runs past its paragraph, so a heading, a
// list item or a table row is its own boundary. Comment markers and closers in
// the way are stepped over, never split, and a full stop inside one never ends
// a sentence. Common abbreviations (e.g., Dr.) and initials do not end one
// either. Anything this misreads, the reader can still select by hand.

import type { MarkerRange } from './types';

export interface SentenceRange {
	from: number;
	to: number;
}

const TERMINATORS = '.!?…';
const CLOSERS = '"\')]}”’»';

// Lower-case, without the full stop. A word before a `.` matching one of these
// is an abbreviation, not the end of a sentence.
const ABBREVIATIONS = new Set([
	'e.g',
	'i.e',
	'etc',
	'vs',
	'mr',
	'mrs',
	'ms',
	'dr',
	'prof',
	'st',
	'jr',
	'sr',
	'no',
	'fig',
	'cf',
	'al',
	'approx',
]);

// A list marker, task box, heading or blockquote at the start of a line is
// markup, not part of the first sentence.
const LINE_PREFIX_RE =
	/^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;

export function sentenceAt(
	content: string,
	offset: number,
	occupied: readonly MarkerRange[],
): SentenceRange | undefined {
	if (occupied.some((r) => offset > r.start && offset < r.end))
		return undefined;
	const block = blockAround(content, offset, occupied);
	if (!block) return undefined;
	const { start: paraStart, end: paraEnd } = block;

	const inMarker = (pos: number): boolean =>
		occupied.some((r) => pos >= r.start && pos < r.end);
	const isSpace = (pos: number): boolean => /\s/.test(content.charAt(pos));
	const startsMarker = (pos: number): boolean =>
		occupied.some((r) => r.start === pos);

	// The index one past a terminator (and any closing quotes after it) when
	// the sentence really ends there, or -1.
	const endsAt = (pos: number): number => {
		const ch = content.charAt(pos);
		if (!TERMINATORS.includes(ch) || inMarker(pos)) return -1;
		if (ch === '.' && isAbbreviation(content, paraStart, pos)) return -1;
		let after = pos + 1;
		while (after < paraEnd && TERMINATORS.includes(content.charAt(after)))
			after += 1;
		while (after < paraEnd && CLOSERS.includes(content.charAt(after)))
			after += 1;
		// Only a break before the next sentence ends this one: 3.5 and a.b do
		// not. A marker straight after the full stop counts as that break.
		if (after < paraEnd && !isSpace(after) && !startsMarker(after))
			return -1;
		return after;
	};

	// Start: just past the last sentence end before the cursor, or the
	// paragraph start, then past whitespace, line markup and markers.
	let from = paraStart;
	for (let pos = Math.min(offset, paraEnd) - 1; pos >= paraStart; pos--) {
		const end = endsAt(pos);
		// Strictly before the cursor: a sentence that ends exactly at the
		// cursor is the one the cursor is in, as at the end of "word.|".
		if (end !== -1 && end < offset) {
			from = end;
			break;
		}
	}
	from = skipLeading(content, from, paraEnd, occupied);

	// End: the first sentence end at or after the start that reaches the
	// cursor, or the paragraph end.
	let to = paraEnd;
	for (let pos = from; pos < paraEnd; pos++) {
		const end = endsAt(pos);
		if (end !== -1 && end > offset - 1) {
			to = end;
			break;
		}
	}
	// Back off trailing whitespace and any markers or closers sitting at the
	// end, which belong to other comments.
	for (;;) {
		while (to > from && isSpace(to - 1)) to -= 1;
		const tail = occupied.find((r) => r.end === to && r.start >= from);
		if (!tail) break;
		to = tail.start;
	}
	// The last word on it: neither end may sit inside a marker or closer. The
	// composer inserts the new marker at `from` and its closer at `to`, and
	// either landing inside another comment's text breaks that comment.
	const inside = (pos: number): boolean =>
		occupied.some((r) => pos > r.start && pos < r.end);
	if (inside(from) || inside(to)) return undefined;
	return to > from ? { from, to } : undefined;
}

// The block of lines a sentence can live in: the cursor's line plus the lines
// above and below it that continue the same prose. A blank line ends a block,
// and so does a change of kind: a heading or a table row is a block of its own,
// a list item starts a new block, and quoted lines do not run into unquoted
// ones. Soft line breaks inside a paragraph are kept.
//
// A line that starts inside an existing marker or closer is never a boundary
// and never markup. Its text is the comment's, so a blank line or a "- " in a
// comment body says nothing about the prose around it. Treating one as a
// paragraph break once put a sentence's start inside a comment.
//
// Undefined when the cursor's own line is blank.
function blockAround(
	content: string,
	offset: number,
	occupied: readonly MarkerRange[],
): { start: number; end: number } | undefined {
	const lines: { start: number; end: number }[] = [];
	for (let at = 0; ;) {
		const nl = content.indexOf('\n', at);
		const end = nl === -1 ? content.length : nl;
		lines.push({ start: at, end });
		if (nl === -1) break;
		at = nl + 1;
	}
	const here = lines.findIndex((l) => offset >= l.start && offset <= l.end);
	const cur = lines[here];
	if (!cur) return undefined;

	const covered = (i: number): boolean => {
		const l = lines[i];
		return (
			l !== undefined &&
			occupied.some((r) => l.start > r.start && l.start < r.end)
		);
	};
	const text = (i: number): string => {
		const l = lines[i];
		return l ? content.slice(l.start, l.end) : '';
	};
	const blank = (i: number): boolean => !covered(i) && text(i).trim() === '';
	const solo = (i: number): boolean =>
		!covered(i) && SOLO_LINE_RE.test(text(i));
	const item = (i: number): boolean =>
		!covered(i) && ITEM_LINE_RE.test(text(i));
	const quoted = (i: number): boolean =>
		!covered(i) && QUOTE_LINE_RE.test(text(i));
	// Two neighbouring lines belong to one block.
	const joins = (upper: number, lower: number): boolean =>
		!blank(upper) &&
		!blank(lower) &&
		!solo(upper) &&
		!solo(lower) &&
		!item(lower) &&
		(covered(lower) || quoted(upper) === quoted(lower));

	// A table row is not a sentence. A new comment's marker spans several lines,
	// and one inserted into a row would end the table there.
	if (blank(here) || (!covered(here) && TABLE_ROW_RE.test(text(here))))
		return undefined;
	let first = here;
	if (!solo(here)) while (first > 0 && joins(first - 1, first)) first -= 1;
	let last = here;
	if (!solo(here))
		while (last < lines.length - 1 && joins(last, last + 1)) last += 1;
	const top = lines[first];
	const bottom = lines[last];
	if (!top || !bottom) return undefined;
	return { start: top.start, end: bottom.end };
}

// A heading or a table row: a block on its own.
const SOLO_LINE_RE = /^[ \t]*(?:#{1,6}[ \t]|\|)/;
// A table row.
const TABLE_ROW_RE = /^[ \t]*\|/;
// A list item, which starts a new block.
const ITEM_LINE_RE = /^[ \t]*(?:>[ \t]?)*(?:[-*+]|\d+[.)])[ \t]/;
// A quoted line.
const QUOTE_LINE_RE = /^[ \t]*>/;

// Whitespace, the line's markdown prefix, and existing markers, repeatedly,
// so the sentence starts at its first word.
function skipLeading(
	content: string,
	from: number,
	limit: number,
	occupied: readonly MarkerRange[],
): number {
	let pos = from;
	for (;;) {
		const before = pos;
		while (pos < limit && /\s/.test(content.charAt(pos))) pos += 1;
		const lineStart = content.lastIndexOf('\n', pos - 1) + 1;
		if (content.slice(lineStart, pos).trim() === '') {
			const prefix = LINE_PREFIX_RE.exec(content.slice(lineStart, limit));
			if (prefix && lineStart + prefix[0].length > pos)
				pos = lineStart + prefix[0].length;
		}
		const marker = occupied.find((r) => r.start === pos);
		if (marker) pos = marker.end;
		if (pos === before) return pos;
	}
}

// The word before the `.` at `dot` is an abbreviation or an initial.
function isAbbreviation(content: string, floor: number, dot: number): boolean {
	let start = dot;
	while (start > floor && /[\p{L}.]/u.test(content.charAt(start - 1)))
		start -= 1;
	const word = content.slice(start, dot).toLowerCase();
	if (word === '') return false;
	if (ABBREVIATIONS.has(word)) return true;
	// A single capital letter: an initial, as in "J. R. R. Tolkien".
	return word.length === 1 && /\p{Lu}/u.test(content.charAt(start));
}
