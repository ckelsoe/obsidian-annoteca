// Where a range comment's closer goes (#84). Pure over the note's editor text,
// so the rules are testable without an editor.
//
// The closer is an HTML comment, and an HTML comment is only invisible where
// markdown treats raw HTML as HTML. Inside a code block or an inline code span
// it shows up as literal text in the note, and inside the properties block it
// breaks the YAML. A selection that would put an end there gets no closer: the
// comment is written the way every comment was before ranges, marking where its
// passage starts, and the caller says why.
//
// The code tests read the text, not a parse tree, and they lean towards
// refusing. Refusing costs only the closer; a closer printed inside code is
// visible damage in the note. So an indented line that might be a nested list
// paragraph rather than an indented code block is treated as code.

import { frontmatterEnd } from './frontmatter';
import { backslashRunBefore, unclosedOpenerRanges } from './parser';
import { inlineCodeSpans } from './code-spans';
import { countWhile, SpanIndex } from './span-index';
import { scanStoreEntries } from './store';
import type { MarkerRange } from './types';

export type CloserPlan =
	| { kind: 'range'; at: number }
	| { kind: 'none' }
	| { kind: 'refused'; reason: string };

export const CLOSER_REFUSED_MESSAGE =
	'This comment marks where its passage starts, not where it ends: a commented range cannot start or end inside a code block, inline code, or the note properties.';

// `from`/`to` are the selection's editor offsets. `occupied` is every existing
// marker and closer, which the closer must not land inside.
export function planCloser(
	content: string,
	from: number,
	to: number,
	occupied: readonly MarkerRange[],
): CloserPlan {
	// The closer sits straight after the passage's last character. A selection
	// that runs on into trailing spaces or line breaks would otherwise put it at
	// the start of the next line, outside the text the reader picked.
	let end = to;
	// A range never runs into the end-of-file comment store: a closer inside
	// a store entry ends that entry early and loses the comment it holds, and
	// one after the store would make the store part of the passage. It stops
	// where the store starts.
	// Looked up, not walked: a batch of promoted comments plans a closer for
	// each, and walking every store entry, open marker and occupied range per
	// plan was quadratic. Both lists are in document order, so the loop that
	// clamped `end` to each start in turn stopped at the first start at or
	// after `from`, if that is before `end`.
	const scanned = closerScan(content);
	const firstStore = firstAtOrAfter(scanned.storeStarts, from);
	if (firstStore !== undefined && firstStore < end) end = firstStore;
	// A marker opener with no `-->` of its own hides everything up to the next
	// one, so a closer in there is hidden too, and the next `-->` it reaches
	// may be another comment's. The range stops at that opener, and a passage
	// that starts inside one gets no closer.
	if (scanned.unclosedIndex.some(from, from)) return { kind: 'none' };
	const firstOpen = firstAtOrAfter(scanned.unclosedStarts, from);
	if (firstOpen !== undefined && firstOpen < end) end = firstOpen;
	while (end > from && /\s/.test(content.charAt(end - 1))) end -= 1;
	// A selection ending inside an existing marker or closer ends after it.
	// Splitting one would break that comment.
	const index = occupiedIndex(occupied);
	const holding = index.overlapping(end, end);
	const only = holding.length === 1 ? holding[0] : undefined;
	// One range holds it and none holds that range's end: the walk would
	// move `end` there and nowhere further. Otherwise the ranges overlap,
	// which callers never pass, and the walk itself decides.
	if (only !== undefined && !index.some(only.end, only.end)) end = only.end;
	else if (holding.length > 0)
		for (const r of occupied) if (end > r.start && end < r.end) end = r.end;
	// The same for an HTML comment that is not Annoteca's: a closer inside one
	// would end it early and show the rest of it as text. They never overlap,
	// so at most one holds `end`.
	const comment = scanned.htmlCommentIndex.first(end, end);
	if (comment !== undefined && end > comment.start && end < comment.end)
		end = comment.end;
	if (end <= from) return { kind: 'none' };

	if (
		inFrontmatter(content, from) ||
		inFrontmatter(content, end) ||
		inCode(content, from) ||
		inCode(content, end)
	) {
		return { kind: 'refused', reason: CLOSER_REFUSED_MESSAGE };
	}
	return { kind: 'range', at: end };
}

// The store entries and the unclosed openers outside the properties, for the
// last note planned in, so a batch of promoted comments scans the note once.
let lastScan:
	| {
			content: string;
			storeStarts: number[];
			unclosedStarts: number[];
			unclosedIndex: SpanIndex<MarkerRange>;
			htmlCommentIndex: SpanIndex<MarkerRange>;
	  }
	| undefined;
function closerScan(content: string): NonNullable<typeof lastScan> {
	if (lastScan?.content !== content) {
		const properties = frontmatterEnd(content);
		// Inside the properties an open marker hides nothing (see
		// forbiddenRanges).
		const unclosed = unclosedOpenerRanges(content).filter(
			(r) => r.start >= properties,
		);
		lastScan = {
			content,
			storeStarts: scanStoreEntries(content).map((e) => e.start),
			unclosedStarts: unclosed.map((r) => r.start),
			unclosedIndex: new SpanIndex(unclosed, (r) => r),
			htmlCommentIndex: new SpanIndex(
				htmlCommentRanges(content),
				(r) => r,
			),
		};
	}
	return lastScan;
}

// The first of `sorted` at or after `x`.
function firstAtOrAfter(
	sorted: readonly number[],
	x: number,
): number | undefined {
	const lo = countWhile(
		sorted.length,
		(mid) => (sorted[mid] ?? Infinity) < x,
	);
	return sorted[lo];
}

// An index per occupied list. A batch passes the same list for every plan,
// so it is indexed once.
const occupiedIndexes = new WeakMap<
	readonly MarkerRange[],
	SpanIndex<MarkerRange>
>();
function occupiedIndex(
	occupied: readonly MarkerRange[],
): SpanIndex<MarkerRange> {
	let index = occupiedIndexes.get(occupied);
	if (index === undefined) {
		index = new SpanIndex(occupied, (r) => r);
		occupiedIndexes.set(occupied, index);
	}
	return index;
}

// Where the note properties end, kept in its own module so store.ts can ask
// too without importing this file (which imports store.ts).
export { frontmatterEnd };

function inFrontmatter(content: string, pos: number): boolean {
	return pos < frontmatterEnd(content);
}

// Every HTML comment in the note that is not Annoteca's own, from its `<!--`
// to the end of the `-->` that closes it: a diagram note, a citation, a
// hand-written TODO. Comments do not nest, so a marker or closer written inside
// one ends it at the marker's own `-->`, and the rest of it shows in the note as
// text. Annoteca's markers, closers and store entries are left out, since
// forbiddenRanges lists those itself, and so is anything the reader cannot
// write a comment into by accident:
//
//   - an escaped `\<!--` (an odd run of backslashes), which is text;
//   - one in a code span or a fenced block, which markdown prints as text.
//     Not an indented block: a list item indented four spaces looks the same,
//     and a comment there must be protected, while treating a rare indented
//     code example as a comment only refuses a new comment inside it;
//   - one in the note properties, which are not rendered as HTML;
//   - one with no `-->` after it, which hides the rest of the note in reading
//     view. Claiming everything below it would refuse every comment there over
//     a stray `<!--` in prose, so that one is left to the reader to see.
//
// `<!-->` and `<!--->` are empty comments in HTML, and are skipped as such.
export function htmlCommentRanges(content: string): MarkerRange[] {
	if (lastHtmlComments?.content === content) return lastHtmlComments.ranges;
	const ranges: MarkerRange[] = [];
	// Read left to right, the way markdown reads inline text: a code span and
	// an HTML comment each run from where they start, and whichever starts
	// first holds the other. A backtick inside a comment is not code, and a
	// `<!--` inside a code span is not a comment, so neither can be asked
	// about on its own (inInlineCode pairs backticks across comments).
	//
	// Fences the same way, with this scan's own fence state rather than the
	// note-wide one: a fence line inside an HTML comment is not a fence, and
	// counting it turns everything after it inside out. Lines a comment or a
	// code span covers do not move the state.
	let pos = frontmatterEnd(content);
	let open: OpenFence | undefined;
	// The next backtick and `<!--` at or after `pos` (Infinity when there are
	// none left), searched again only once `pos` passes them: searching on
	// every line was quadratic in a long note with few of either.
	let tick = -1;
	let opener = -1;
	const find = (needle: string): number => {
		const at = content.indexOf(needle, pos);
		return at === -1 ? Infinity : at;
	};
	const note = noteLines(content);
	const spanEnds = inlineBlockEnds(note.lines);
	const runs = new Map<number, Map<number, number[]>>();
	for (const [i, line] of note.lines.entries()) {
		if (line.end < pos) continue;
		if (line.start >= pos) {
			const step = fenceStep(line.body, open);
			open = step.open;
			if (step.fenced) {
				pos = line.end + 1;
				continue;
			}
		}
		for (;;) {
			if (tick < pos) tick = find('`');
			if (opener < pos) opener = find('<!--');
			if (Math.min(tick, opener) >= line.end) break;
			if (tick < opener) {
				// An escaped backtick is text, and opens nothing.
				if (backslashRunBefore(content, tick) % 2 === 1) {
					pos = tick + 1;
					continue;
				}
				const run = runLength(content, tick);
				const close = closingRun(
					content,
					tick + run,
					run,
					spanEnds[i] ?? content.length,
					runs,
				);
				pos = close === -1 ? tick + run : close + run;
				continue;
			}
			const after = opener + 4;
			// An odd run of backslashes escapes it. An even run is escaped
			// backslashes, and the comment after them is live.
			if (
				backslashRunBefore(content, opener) % 2 === 1 ||
				content.startsWith('>', after) ||
				content.startsWith('->', after)
			) {
				pos = after;
				continue;
			}
			const close = content.indexOf('-->', after);
			// No `-->`: it hides the rest of the note, and nothing after it
			// is a comment of its own.
			if (close === -1) {
				lastHtmlComments = { content, ranges };
				return ranges;
			}
			pos = close + 3;
			// One of Annoteca's own is skipped whole, so an older marker
			// whose text quotes an HTML comment is not read as holding one.
			if (!ANNOTECA_COMMENT_RE.test(content.slice(after, after + 16)))
				ranges.push({ start: opener, end: pos });
		}
	}
	lastHtmlComments = { content, ranges };
	return ranges;
}

// For each line, where a code span opened on it must close by: the end of the
// last line before the next blank line or the next line that starts a block
// (a fence, a heading, a list item), all of which end a paragraph. Ending one
// too early only reads its backticks as text, so a comment after them is
// still protected; the other way round hides it. One pass from the end.
function inlineBlockEnds(lines: readonly Line[]): number[] {
	const ends: number[] = new Array<number>(lines.length).fill(0);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line === undefined) continue;
		const next = lines[i + 1];
		// A heading is one line long, so a span opened in it ends with it.
		ends[i] =
			next === undefined ||
			startsBlock(next.body) ||
			HEADING_RE.test(line.body)
				? line.end
				: (ends[i + 1] ?? line.end);
	}
	return ends;
}

const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;

const BLOCK_START_RE =
	/^ {0,3}(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d{1,9}[.)][ \t])/;

function startsBlock(body: string): boolean {
	return (
		isBlank(body) || FENCE_LINE_RE.test(body) || BLOCK_START_RE.test(body)
	);
}

// Where the backtick run of exactly `run` that closes a code span opened just
// before `from` starts, or -1. The search stops at `end`, where the paragraph
// ends (see inlineBlockEnds; lines are read without their quote markers, so a
// bare `>` line in a quote is blank).
//
// Each paragraph's backtick runs are collected once, by length, into `runs`:
// a paragraph full of unmatched backticks searched to its end once per run
// otherwise.
function closingRun(
	content: string,
	from: number,
	run: number,
	end: number,
	runs: Map<number, Map<number, number[]>>,
): number {
	let byLength = runs.get(end);
	if (byLength === undefined) {
		byLength = new Map();
		// From the first span opened in the paragraph: every later one in it
		// opens after that, so the runs before it are never asked for.
		for (let at = content.indexOf('`', from); at !== -1 && at < end;) {
			const len = runLength(content, at);
			const list = byLength.get(len);
			if (list) list.push(at);
			else byLength.set(len, [at]);
			at = content.indexOf('`', at + len);
		}
		runs.set(end, byLength);
	}
	const list = byLength.get(run) ?? [];
	const lo = countWhile(list.length, (mid) => (list[mid] ?? Infinity) < from);
	return list[lo] ?? -1;
}

// The length of the backtick run starting at `at`.
function runLength(text: string, at: number): number {
	let n = 0;
	while (text.charAt(at + n) === '`') n += 1;
	return n;
}

// What follows `<!--` in Annoteca's own comments: a marker
// (`annoteca/<category>:`), a closer (`/annoteca <id>`) or a store entry
// (`annoteca:store`), with any spacing the parser allows before it. Not
// `annoteca` alone: `<!-- annoteca notes: ... -->` is an ordinary comment.
const ANNOTECA_COMMENT_RE = /^\s*(?:annoteca\/|\/annoteca\s|annoteca:store)/i;

let lastHtmlComments: { content: string; ranges: MarkerRange[] } | undefined;

// Any code context markdown would print a closer in: a fenced block (also one
// inside a blockquote), an indented code block, or an inline code span.
function inCode(content: string, pos: number): boolean {
	return (
		inFencedCode(content, pos) ||
		inIndentedCode(content, pos) ||
		inInlineCode(content, pos)
	);
}

// The lines of the note with their start offsets, and each line with any
// blockquote prefix (`>` markers) removed, since code inside a quote is still
// code.
interface Line {
	start: number;
	end: number;
	body: string;
}

function linesOf(content: string): Line[] {
	const out: Line[] = [];
	let start = 0;
	for (;;) {
		const nl = content.indexOf('\n', start);
		const end = nl === -1 ? content.length : nl;
		out.push({ start, end, body: stripQuote(content.slice(start, end)) });
		if (nl === -1) return out;
		start = nl + 1;
	}
}

// Drops leading blockquote markers: up to three spaces, `>`, one optional
// space, repeated for nested quotes. A loop rather than a regex, to keep the
// scan linear.
function stripQuote(line: string): string {
	let i = 0;
	for (;;) {
		let j = i;
		while (j < i + 3 && line.charAt(j) === ' ') j += 1;
		if (line.charAt(j) !== '>') return line.slice(i);
		j += 1;
		if (line.charAt(j) === ' ') j += 1;
		i = j;
	}
}

// The first line holding `pos` (a line's end, its line break, counts as on
// it), as findIndex over the lines answered, by binary search.
const lineAt = (lines: readonly Line[], pos: number): number => {
	const lo = countWhile(
		lines.length,
		(mid) => (lines[mid]?.end ?? Infinity) < pos,
	);
	const line = lines[lo];
	return line !== undefined && pos >= line.start ? lo : -1;
};

// One note's lines and which of them are fenced code, worked out once. Every
// closer plan asks about two positions, a batch of promoted comments asks for
// each, and splitting the note into lines and walking its fences from the top
// per question was quadratic in the note. The last note asked about is kept;
// a different one replaces it.
interface NoteLines {
	content: string;
	lines: Line[];
	// Line i is inside a fenced block, or is one of its fence lines.
	fenced: boolean[];
	// For each line, the first and last line of the run of non-blank lines
	// around it, as inInlineCode walks them: back while the line above is not
	// blank, forward while the line below is not. A blank line's run takes in
	// the paragraphs on both sides.
	up: number[];
	down: number[];
	// For each line, the top of the run of indented or blank lines directly
	// above it, as inIndentedCode walks it.
	runTop: number[];
	// Inline code spans per run, keyed by both ends of it, as sorted
	// [open, close + run) note offsets. Filled as runs are asked about.
	spans: Map<string, [number, number][]>;
}
// The fence a fenced block was opened with.
interface OpenFence {
	char: string;
	len: number;
}

// One line through the fence state: whether the line is fenced (inside a
// block, or one of its fence lines), and the state after it.
function fenceStep(
	body: string,
	open: OpenFence | undefined,
): { fenced: boolean; open: OpenFence | undefined } {
	const match = FENCE_LINE_RE.exec(body);
	const fence = match?.[1];
	// An opening fence may carry an info string (```js), but a closing one
	// may carry nothing but whitespace, as CommonMark has it. Without that
	// rule a ```js line inside an open block would close it, and the rest
	// of the block would read as prose.
	const closes = match !== null && body.slice(match[0].length).trim() === '';
	const isDelimiter =
		fence !== undefined &&
		(open === undefined ||
			(closes &&
				fence.startsWith(open.char) &&
				fence.length >= open.len));
	const fenced = open !== undefined || isDelimiter;
	if (fence === undefined || !isDelimiter) return { fenced, open };
	return {
		fenced,
		open:
			open === undefined
				? { char: fence.charAt(0), len: fence.length }
				: undefined,
	};
}

let lastLines: NoteLines | undefined;
function noteLines(content: string): NoteLines {
	if (lastLines?.content === content) return lastLines;
	const lines = linesOf(content);
	const fenced: boolean[] = [];
	let open: OpenFence | undefined;
	for (const line of lines) {
		const step = fenceStep(line.body, open);
		fenced.push(step.fenced);
		open = step.open;
	}
	const blank = lines.map((l) => isBlank(l.body));
	const up: number[] = [];
	for (let i = 0; i < lines.length; i++)
		up.push(i > 0 && !blank[i - 1] ? (up[i - 1] ?? 0) : i);
	const down: number[] = new Array<number>(lines.length);
	for (let i = lines.length - 1; i >= 0; i--)
		down[i] =
			i < lines.length - 1 && !blank[i + 1] ? (down[i + 1] ?? i) : i;
	const runTop: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const prev = lines[i - 1];
		runTop.push(
			prev !== undefined && (isIndented(prev.body) || isBlank(prev.body))
				? (runTop[i - 1] ?? i)
				: i,
		);
	}
	lastLines = {
		content,
		lines,
		fenced,
		up,
		down,
		runTop,
		spans: new Map(),
	};
	return lastLines;
}

const isBlank = (body: string): boolean => body.trim() === '';

// A fence opens with three or more backticks or tildes, indented at most three
// spaces, and closes with a run of the same character at least as long.
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

// Inside a fenced block, its opening and closing lines included. An unclosed
// fence runs to the end of the note, which is how markdown renders it.
function inFencedCode(content: string, pos: number): boolean {
	const note = noteLines(content);
	return note.fenced[lineAt(note.lines, pos)] ?? false;
}

// An indented code block: a non-blank line indented by a tab or four spaces,
// whose run of such lines starts after a blank line or at the top of the note.
// A paragraph's own continuation lines can be indented too, and those are prose,
// which is why the run has to begin after a blank line.
const isIndented = (body: string): boolean =>
	!isBlank(body) && (body.startsWith('\t') || body.startsWith('    '));

function inIndentedCode(content: string, pos: number): boolean {
	const note = noteLines(content);
	const { lines } = note;
	const target = lineAt(lines, pos);
	const line = lines[target];
	if (!line || !isIndented(line.body)) return false;
	// The top of the run of indented (or blank) lines above it.
	const i = note.runTop[target] ?? target;
	const first = lines[i];
	const before = lines[i - 1];
	return (
		i === 0 ||
		(first !== undefined && isBlank(first.body)) ||
		(before !== undefined && isBlank(before.body))
	);
}

// Strictly inside an inline code span: a backtick run opens one, and the next
// run of exactly the same length closes it. A run with no partner is literal
// backticks. A span can cross a line break, so the scan covers the whole
// paragraph around `pos`, not just its line. A position at either edge of the
// span is outside it. A scanner rather than a regex, because the regex form
// needs a lookbehind, which older iOS cannot even parse.
function inInlineCode(content: string, pos: number): boolean {
	const note = noteLines(content);
	const { lines } = note;
	const target = lineAt(lines, pos);
	const first = note.up[target];
	const last = note.down[target];
	if (first === undefined || last === undefined) return false;
	const key = `${first}:${last}`;
	let spans = note.spans.get(key);
	if (spans === undefined) {
		const startLine = lines[first];
		const endLine = lines[last];
		if (!startLine || !endLine) return false;
		spans = inlineCodeSpans(
			content.slice(startLine.start, endLine.end),
		).map(([a, b]) => [startLine.start + a, startLine.start + b]);
		note.spans.set(key, spans);
	}
	// The spans do not overlap and are in order: the last one opening before
	// `pos` is the only one that can hold it.
	const lo = countWhile(
		spans.length,
		(mid) => (spans[mid]?.[0] ?? Infinity) < pos,
	);
	const span = spans[lo - 1];
	return span !== undefined && pos < span[1];
}
