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
	while (end > from && /\s/.test(content.charAt(end - 1))) end -= 1;
	// A selection ending inside an existing marker or closer ends after it.
	// Splitting one would break that comment.
	for (const r of occupied) if (end > r.start && end < r.end) end = r.end;
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

// The note's frontmatter block, as its end offset, or 0 when it has none. Only
// a block that opens the document counts; a `---` anywhere else is a
// horizontal rule. Shared with forbiddenRanges in comment-service, so the two
// never disagree about where the properties end.
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/;

export function frontmatterEnd(content: string): number {
	return FRONTMATTER_RE.exec(content)?.[0].length ?? 0;
}

function inFrontmatter(content: string, pos: number): boolean {
	return pos < frontmatterEnd(content);
}

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

const lineAt = (lines: readonly Line[], pos: number): number =>
	lines.findIndex((l) => pos >= l.start && pos <= l.end);

const isBlank = (body: string): boolean => body.trim() === '';

// A fence opens with three or more backticks or tildes, indented at most three
// spaces, and closes with a run of the same character at least as long.
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

// Inside a fenced block, its opening and closing lines included. An unclosed
// fence runs to the end of the note, which is how markdown renders it.
function inFencedCode(content: string, pos: number): boolean {
	const lines = linesOf(content);
	const target = lineAt(lines, pos);
	let open: { char: string; len: number } | undefined;
	for (let i = 0; i <= target; i++) {
		const line = lines[i];
		if (!line) break;
		const match = FENCE_LINE_RE.exec(line.body);
		const fence = match?.[1];
		// An opening fence may carry an info string (```js), but a closing one
		// may carry nothing but whitespace, as CommonMark has it. Without that
		// rule a ```js line inside an open block would close it, and the rest
		// of the block would read as prose.
		const closes =
			match !== null && line.body.slice(match[0].length).trim() === '';
		const isDelimiter =
			fence !== undefined &&
			(open === undefined ||
				(closes &&
					fence.startsWith(open.char) &&
					fence.length >= open.len));
		if (i === target) return open !== undefined || isDelimiter;
		if (fence !== undefined && isDelimiter)
			open =
				open === undefined
					? { char: fence.charAt(0), len: fence.length }
					: undefined;
	}
	return false;
}

// An indented code block: a non-blank line indented by a tab or four spaces,
// whose run of such lines starts after a blank line or at the top of the note.
// A paragraph's own continuation lines can be indented too, and those are prose,
// which is why the run has to begin after a blank line.
const isIndented = (body: string): boolean =>
	!isBlank(body) && (body.startsWith('\t') || body.startsWith('    '));

function inIndentedCode(content: string, pos: number): boolean {
	const lines = linesOf(content);
	let i = lineAt(lines, pos);
	const line = lines[i];
	if (!line || !isIndented(line.body)) return false;
	// Walk up the run of indented (or blank) lines to what precedes it.
	while (i > 0) {
		const prev = lines[i - 1];
		if (!prev || !(isIndented(prev.body) || isBlank(prev.body))) break;
		i -= 1;
	}
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
	const lines = linesOf(content);
	const target = lineAt(lines, pos);
	let first = target;
	let last = target;
	while (first > 0 && !isBlank(lines[first - 1]?.body ?? '')) first -= 1;
	while (last < lines.length - 1 && !isBlank(lines[last + 1]?.body ?? ''))
		last += 1;
	const startLine = lines[first];
	const endLine = lines[last];
	if (!startLine || !endLine) return false;
	const para = content.slice(startLine.start, endLine.end);
	const local = pos - startLine.start;
	let i = 0;
	while (i < para.length) {
		if (para.charAt(i) !== '`') {
			i += 1;
			continue;
		}
		const open = runLength(para, i);
		let j = i + open;
		let close = -1;
		while (j < para.length) {
			if (para.charAt(j) !== '`') {
				j += 1;
				continue;
			}
			const run = runLength(para, j);
			if (run === open) {
				close = j;
				break;
			}
			j += run;
		}
		if (close === -1) {
			i += open;
			continue;
		}
		if (local > i && local < close + open) return true;
		i = close + open;
	}
	return false;
}

function runLength(text: string, at: number): number {
	let n = 0;
	while (text.charAt(at + n) === '`') n += 1;
	return n;
}
