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

import { SpanIndex } from './span-index';
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
const LONGEST_ABBREVIATION = Math.max(
	...[...ABBREVIATIONS].map((w) => w.length),
);

// A list marker, task box, heading or blockquote at the start of a line is
// markup, not part of the first sentence.
const LINE_PREFIX_RE =
	/^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;

// The markers and closers a sentence has to step around, indexed once per
// lookup so the questions below are not each a scan of every comment in the
// note: asked per position and per line, those scans were quadratic in a long
// paragraph full of comments. Each answers what the scan it replaced did,
// including which range a find over the list returned first.
class Occupied {
	readonly index: SpanIndex<MarkerRange>;
	private readonly byStart = new Map<number, MarkerRange>();
	private readonly byEnd = new Map<number, MarkerRange[]>();

	constructor(ranges: readonly MarkerRange[]) {
		this.index = new SpanIndex(ranges, (r) => r);
		for (const r of ranges) {
			if (!this.byStart.has(r.start)) this.byStart.set(r.start, r);
			const list = this.byEnd.get(r.end);
			if (list) list.push(r);
			else this.byEnd.set(r.end, [r]);
		}
	}

	// Whether `pos` is strictly between some range's start and end.
	strictlyInside(pos: number): boolean {
		return this.index.some(pos, pos);
	}

	startingAt(pos: number): MarkerRange | undefined {
		return this.byStart.get(pos);
	}

	// The first range, in list order, ending at `end` and starting at or
	// after `from`.
	endingAt(end: number, from: number): MarkerRange | undefined {
		return this.byEnd.get(end)?.find((r) => r.start >= from);
	}
}

export function sentenceAt(
	content: string,
	offset: number,
	ranges: readonly MarkerRange[],
): SentenceRange | undefined {
	const occupied = new Occupied(ranges);
	if (occupied.strictlyInside(offset)) return undefined;
	const block = blockAround(content, offset, occupied);
	if (!block) return undefined;
	const { start: paraStart, end: paraEnd } = block;

	const inMarker = (pos: number): boolean =>
		occupied.index.some(pos, pos + 1);
	const isSpace = (pos: number): boolean => /\s/.test(content.charAt(pos));
	const startsMarker = (pos: number): boolean =>
		occupied.startingAt(pos) !== undefined;

	// Where each run of terminators, and each run of closing quotes, ends,
	// found once from the right: the scan asks this at every position, and
	// walking a long run of `!` afresh each time was quadratic.
	const runEnds = (chars: string): number[] => {
		const out: number[] = new Array<number>(paraEnd - paraStart + 1);
		out[paraEnd - paraStart] = paraEnd;
		for (let i = paraEnd - 1; i >= paraStart; i--)
			out[i - paraStart] = chars.includes(content.charAt(i))
				? (out[i + 1 - paraStart] ?? paraEnd)
				: i;
		return out;
	};
	const termEnd = runEnds(TERMINATORS);
	const closerEnd = runEnds(CLOSERS);
	const skip = (ends: number[], at: number): number =>
		at >= paraEnd ? at : (ends[at - paraStart] ?? at);

	// The index one past a terminator (and any closing quotes after it) when
	// the sentence really ends there, or -1.
	const endsAt = (pos: number): number => {
		const ch = content.charAt(pos);
		if (!TERMINATORS.includes(ch) || inMarker(pos)) return -1;
		if (ch === '.' && isAbbreviation(content, paraStart, pos)) return -1;
		const after = skip(closerEnd, skip(termEnd, pos + 1));
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
		const tail = occupied.endingAt(to, from);
		if (!tail) break;
		to = tail.start;
	}
	// The last word on it: neither end may sit inside a marker or closer. The
	// composer inserts the new marker at `from` and its closer at `to`, and
	// either landing inside another comment's text breaks that comment.
	if (occupied.strictlyInside(from) || occupied.strictlyInside(to))
		return undefined;
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
	occupied: Occupied,
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

	// Each line's facts are worked out once: the block walk and the table
	// check below ask them again and again.
	const memo = <T>(f: (i: number) => T): ((i: number) => T) => {
		const seen = new Map<number, T>();
		return (i) => {
			if (seen.has(i)) return seen.get(i) as T;
			const v = f(i);
			seen.set(i, v);
			return v;
		};
	};
	const covered = memo((i: number): boolean => {
		const l = lines[i];
		return l !== undefined && occupied.strictlyInside(l.start);
	});
	const text = memo((i: number): string => {
		const l = lines[i];
		return l ? content.slice(l.start, l.end) : '';
	});
	// Blank once any quote markers are gone: a lone `>` separates two quoted
	// paragraphs the way an empty line separates two plain ones.
	const blank = memo(
		(i: number): boolean =>
			!covered(i) && stripQuotes(text(i)).trim() === '',
	);
	const solo = (i: number): boolean =>
		!covered(i) && SOLO_LINE_RE.test(text(i));
	const item = (i: number): boolean =>
		!covered(i) && ITEM_LINE_RE.test(text(i));
	const depth = (i: number): number =>
		covered(i) ? -1 : quoteDepth(text(i));
	// A table, with or without outer pipes: a line holding a `|` in a run of
	// lines that includes a delimiter row (`---|---`, `| :-- | --: |`).
	const delimiter = (i: number): boolean =>
		!covered(i) && isDelimiterRow(text(i));
	// Whether the run of non-blank lines around line i holds a delimiter row,
	// worked out once per run: walking the run up and down for every line in
	// it was quadratic in a long table.
	const runHasDelimiter = memo((i: number): boolean => {
		let top = i;
		while (top > 0 && !blank(top - 1)) top -= 1;
		let found = false;
		let j = top;
		for (; j < lines.length && !blank(j); j++)
			if (delimiter(j)) found = true;
		for (let k = top; k < j; k++) runDelimiter.set(k, found);
		return found;
	});
	const runDelimiter = new Map<number, boolean>();
	const inTable = (i: number): boolean => {
		if (covered(i) || !text(i).includes('|')) return false;
		// A row that opens with a pipe is treated as a table even without a
		// delimiter row nearby: refusing costs only the shortcut.
		if (text(i).trimStart().startsWith('|')) return true;
		return runDelimiter.get(i) ?? runHasDelimiter(i);
	};
	// Two neighbouring lines belong to one block. A line inside a comment
	// carries no quote depth of its own, so it never splits on depth.
	const joins = (upper: number, lower: number): boolean =>
		!blank(upper) &&
		!blank(lower) &&
		!solo(upper) &&
		!solo(lower) &&
		!item(lower) &&
		!inTable(upper) &&
		!inTable(lower) &&
		(covered(lower) || covered(upper) || depth(upper) === depth(lower));

	// A table row is not a sentence. A new comment's marker spans several lines,
	// and one inserted into a row would end the table there.
	if (blank(here) || inTable(here)) return undefined;
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

// A heading or a leading-pipe table row: a block on its own.
const SOLO_LINE_RE = /^[ \t]*(?:#{1,6}[ \t]|\|)/;
// A list item, which starts a new block.
const ITEM_LINE_RE = /^[ \t]*(?:>[ \t]?)*(?:[-*+]|\d+[.)])[ \t]/;
// How many `>` quote markers open the line: 0 for plain prose, 2 for `>> `.
function quoteDepth(line: string): number {
	let depth = 0;
	let i = 0;
	for (;;) {
		while (line.charAt(i) === ' ' || line.charAt(i) === '\t') i += 1;
		if (line.charAt(i) !== '>') return depth;
		depth += 1;
		i += 1;
	}
}

// The line with its leading quote markers removed.
function stripQuotes(line: string): string {
	let i = 0;
	for (;;) {
		while (line.charAt(i) === ' ' || line.charAt(i) === '\t') i += 1;
		if (line.charAt(i) !== '>') return line.slice(i);
		i += 1;
	}
}

// A table's delimiter row: only pipes, colons, dashes and spaces, with at
// least one pipe and one dash. A plain `---` rule has no pipe.
function isDelimiterRow(line: string): boolean {
	const t = line.trim();
	return (
		t.includes('|') &&
		t.includes('-') &&
		[...t].every(
			(ch) => ch === '|' || ch === ':' || ch === '-' || ch === ' ',
		)
	);
}

// Whitespace, the line's markdown prefix, and existing markers, repeatedly,
// so the sentence starts at its first word.
function skipLeading(
	content: string,
	from: number,
	limit: number,
	occupied: Occupied,
): number {
	let pos = from;
	// The current line's start, and whether only whitespace precedes `pos`
	// on it, kept as `pos` moves rather than searched for each step: many
	// markers on one line made that search quadratic.
	let lineStart = content.lastIndexOf('\n', pos - 1) + 1;
	let blank = content.slice(lineStart, pos).trim() === '';
	// Each step looks only at the text it moves over.
	const moveTo = (to: number): void => {
		const passed = content.slice(pos, to);
		const nl = passed.lastIndexOf('\n');
		if (nl === -1) blank = blank && passed.trim() === '';
		else {
			lineStart = pos + nl + 1;
			blank = passed.slice(nl + 1).trim() === '';
		}
		pos = to;
	};
	for (;;) {
		const before = pos;
		let ws = pos;
		while (ws < limit && /\s/.test(content.charAt(ws))) ws += 1;
		moveTo(ws);
		if (blank) {
			// The prefix is on one line, so the line is all it needs.
			const eol = content.indexOf('\n', lineStart);
			const prefix = LINE_PREFIX_RE.exec(
				content.slice(
					lineStart,
					eol === -1 ? limit : Math.min(eol, limit),
				),
			);
			if (prefix && lineStart + prefix[0].length > pos)
				moveTo(lineStart + prefix[0].length);
		}
		const marker = occupied.startingAt(pos);
		if (marker) moveTo(marker.end);
		if (pos === before) return pos;
	}
}

// The word before the `.` at `dot` is an abbreviation or an initial.
function isAbbreviation(content: string, floor: number, dot: number): boolean {
	// Walked back no further than the longest abbreviation: a longer word is
	// none of them and not an initial, and walking a long run of letters and
	// dots in full for every dot in it was quadratic.
	let start = dot;
	while (start > floor && /[\p{L}.]/u.test(content.charAt(start - 1))) {
		start -= 1;
		if (dot - start > LONGEST_ABBREVIATION) return false;
	}
	const word = content.slice(start, dot).toLowerCase();
	if (word === '') return false;
	if (ABBREVIATIONS.has(word)) return true;
	// A single capital letter: an initial, as in "J. R. R. Tolkien".
	return word.length === 1 && /\p{Lu}/u.test(content.charAt(start));
}
