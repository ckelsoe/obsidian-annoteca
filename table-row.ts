// Whether an offset is on a table row. Its own module, with no imports, so
// document.ts (storage mode, conversion) and table-cells.ts (repair) can both
// ask without importing each other.

// A table row holds a `|`, with or without outer pipes, also inside a quote
// or callout. Whether it is one depends on the run it sits in (inTableRow),
// the same rule sentence.ts reads tables by. A list item or a heading starts
// a block of its own, which ends a table, so a line opening with one is not a
// row whatever it holds.
const BLOCK_OPENER_RE = /^(?:[-*+][ \t]|\d{1,9}[.)][ \t]|#{1,6}(?:[ \t]|$))/;

// A line's quote depth (how many `>` open it) and the text after them.
function split(line: string): { depth: number; body: string } {
	const prefix = /^[ \t>]*/.exec(line)?.[0] ?? '';
	let depth = 0;
	for (const ch of prefix) if (ch === '>') depth += 1;
	return { depth, body: line.slice(prefix.length) };
}

function isRowLine(line: string): boolean {
	const { body } = split(line);
	return body.includes('|') && !BLOCK_OPENER_RE.test(body);
}

// The row under the header that makes the lines a table: cells of dashes,
// each with an optional colon either side, so nothing but pipes, dashes,
// colons and spaces, with at least one pipe and one dash. Checked by
// characters rather than one pattern, which backtracks on a long row.
function isDelimiter(line: string): boolean {
	const body = line.replace(/^[ \t>]*/, '').trim();
	return (
		body.includes('|') && body.includes('-') && /^[|:\- \t]+$/.test(body)
	);
}

function lineAt(content: string, start: number): string {
	const nl = content.indexOf('\n', start);
	return content.slice(start, nl === -1 ? undefined : nl);
}

// A line holding a pipe is only a row when the run of such lines above it
// reaches a delimiter row (or it is the header, with the delimiter right
// below). Without that it is a paragraph that happens to hold a `|`. A full marker that broke a row still starts on a row line in the run,
// so it is found; a row below the broken one is cut off from the delimiter
// and is not, until the repair joins the table again.
export function inTableRow(content: string, offset: number): boolean {
	const start = content.lastIndexOf('\n', offset - 1) + 1;
	const first = lineAt(content, start);
	if (!isRowLine(first)) return false;
	// A row has its table's quote depth: a quote line below a table that is
	// not quoted (or the reverse) is a block of its own.
	const depth = split(first).depth;
	const sameTable = (line: string): boolean =>
		(isRowLine(line) || isDelimiter(line)) && split(line).depth === depth;
	// Up the run of row lines to its first.
	for (let at = start; ;) {
		const line = lineAt(content, at);
		if (isDelimiter(line)) return true;
		if (at === 0) break;
		// The line above starts after the break before this line's own.
		// From the second line that is the first line, at 0 (searching back
		// from a negative index would find this line's own break again).
		const prev = at >= 2 ? content.lastIndexOf('\n', at - 2) + 1 : 0;
		if (prev >= at || !sameTable(lineAt(content, prev))) break;
		at = prev;
	}
	// The delimiter is the second row, so a header row finds it below.
	const next = content.indexOf('\n', start);
	if (next === -1) return false;
	const below = lineAt(content, next + 1);
	return isDelimiter(below) && split(below).depth === depth;
}

// Where a marker for a comment at `offset` goes in a table row: `offset`
// itself, unless it is at the very start of the row. A marker there would go
// on a line of its own above the row (a marker at the start of a block does),
// which ends the table. With a leading pipe it goes just inside the first
// cell; without one, at the end of the first cell's text, before its `|`.
export function inCell(content: string, offset: number): number {
	const start = content.lastIndexOf('\n', offset - 1) + 1;
	const pipe = cellPipe(content, start);
	if (pipe === -1) return offset;
	const lead = content.slice(start, pipe);
	if (/^[ \t>]*$/.test(lead)) {
		// A leading pipe: before it is the row's start.
		if (offset > pipe) return offset;
		return content.charAt(pipe + 1) === ' ' ? pipe + 2 : pipe + 1;
	}
	// No leading pipe: only the row's start (its indent) moves.
	if (content.slice(start, offset).trim() !== '') return offset;
	let end = pipe;
	while (end > start && /[ \t]/.test(content.charAt(end - 1))) end -= 1;
	return end;
}

// The first `|` on the line starting at `start` that ends a cell, or -1: not
// one escaped by an odd run of backslashes. A table splits its cells on every
// other pipe, inside backticks too, as GFM does.
function cellPipe(content: string, start: number): number {
	const nl = content.indexOf('\n', start);
	const end = nl === -1 ? content.length : nl;
	for (
		let i = content.indexOf('|', start);
		i !== -1 && i < end;
		i = content.indexOf('|', i + 1)
	) {
		let slashes = 0;
		while (content.charAt(i - 1 - slashes) === '\\') slashes += 1;
		if (slashes % 2 === 0) return i;
	}
	return -1;
}
