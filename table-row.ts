// Whether an offset is on a table row. Its own module, with no imports, so
// document.ts (storage mode, conversion) and table-cells.ts (repair) can both
// ask without importing each other.

// A pipe table row: the leading-pipe form, which is what Obsidian writes and
// what its table editor produces, also inside a quote or callout. A table
// written without leading pipes is not recognised, so a comment there is
// written as it always was.
const ROW_RE = /^(?: {0,3}>[ \t]?)* {0,3}\|/;

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

// A line that starts with a pipe is only a row when the run of such lines
// above it reaches a delimiter row (or it is the header, with the delimiter
// right below). Without that it is a paragraph that happens to start with
// `|`. A full marker that broke a row still starts on a row line in the run,
// so it is found; a row below the broken one is cut off from the delimiter
// and is not, until the repair joins the table again.
export function inTableRow(content: string, offset: number): boolean {
	const start = content.lastIndexOf('\n', offset - 1) + 1;
	if (!ROW_RE.test(lineAt(content, start))) return false;
	// Up the run of row lines to its first.
	for (let at = start; ;) {
		const line = lineAt(content, at);
		if (isDelimiter(line)) return true;
		if (at === 0) break;
		// The line above starts after the break before this line's own.
		// From the second line that is the first line, at 0 (searching back
		// from a negative index would find this line's own break again).
		const prev = at >= 2 ? content.lastIndexOf('\n', at - 2) + 1 : 0;
		if (prev >= at || !ROW_RE.test(lineAt(content, prev))) break;
		at = prev;
	}
	// The delimiter is the second row, so a header row finds it below.
	const next = content.indexOf('\n', start);
	return next !== -1 && isDelimiter(lineAt(content, next + 1));
}

// Where a marker for a comment at `offset` goes in a table row: `offset`
// itself, unless it is before the row's leading pipe. A marker there would go
// on a line of its own above the row (a marker at the start of a block does),
// which ends the table. Inside the first cell it stays on the row.
export function inCell(content: string, offset: number): number {
	const start = content.lastIndexOf('\n', offset - 1) + 1;
	const pipe = content.indexOf('|', start);
	if (pipe === -1 || offset > pipe) return offset;
	return content.charAt(pipe + 1) === ' ' ? pipe + 2 : pipe + 1;
}
