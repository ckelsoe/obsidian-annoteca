// Comments in table rows (issue report 2026-10-26, items 2 and 3).
//
// A full marker spans several lines and a table row is one, so a comment
// written into a cell broke the table. Obsidian's table editor then turned the
// marker's line breaks into `<br>`, which mended the row and broke the
// comment: its id, author, range flag and thread read as body text. A comment
// in a cell is now lean in every note, and the repair turns a full marker in a
// row (either shape) into a lean marker plus a store entry.

import {
	hasRepairableTableCell,
	repairTableCellComments,
	tableCellProblems,
} from '../table-cells';
import { inCell, inTableRow } from '../table-row';
import {
	convertFileToInline,
	parseDocument,
	resolveStorageModeForNewComment,
} from '../document';
import { markerProblems } from '../html-comments';
import { hasRepairableDamage, repairComments } from '../quote-repair';
import { parseAll, serializeLeanMarker } from '../parser';
import { parseStore, writeStoreRegion } from '../store';

const HEAD = '| Rule | Applied in |\n| --- | --- |\n';

// As found in the vault: the marker's lines joined with `<br>`.
const BR_CELL =
	HEAD +
	'| One | <!-- annoteca/clarify: what is this column?<br>[id=9v77owhe]<br>[date=2026-10-26T08:36:57]<br>[author=Charles]<br>[anchor=Applied in]<br>[range=closed]<br>[reply claude 2026-10-26T08:54:18]: It lists the decision records.<br>--> Applied in<!-- /annoteca 9v77owhe --> |\n' +
	'| Two | text |\n';

// As the composer used to write it: real line breaks, which end the row.
const NL_CELL =
	HEAD +
	'| One | <!-- annoteca/clarify: a question\n[id=aaaaaaaa]\n[date=2026-10-26T09:00:00]\n[author=Charles]\n--> cell |\n' +
	'| Two | text |\n';

describe('inTableRow', () => {
	it('is true on a leading-pipe row, also in a quote, and false elsewhere', () => {
		expect(inTableRow(BR_CELL, BR_CELL.indexOf('One'))).toBe(true);
		const quoted = '> | a | b |\n> | - | - |\n> | c | d |';
		expect(inTableRow(quoted, quoted.indexOf('a'))).toBe(true);
		expect(inTableRow(quoted, quoted.indexOf('c'))).toBe(true);
		expect(inTableRow('A paragraph | with a pipe', 4)).toBe(false);
		// A paragraph that starts with a pipe is not a table.
		const pipe = '| means OR in this paragraph.';
		expect(inTableRow(pipe, pipe.indexOf('OR'))).toBe(false);
	});
});

describe('a full marker in a table row', () => {
	it.each([
		['joined with <br>', BR_CELL],
		['with real line breaks', NL_CELL],
	])('is reported and repairable when %s', (_, note) => {
		expect(tableCellProblems(note)).toHaveLength(1);
		expect(markerProblems(note).map((f) => f.reason)).toContainEqual(
			expect.stringContaining('table row'),
		);
		expect(hasRepairableTableCell(note)).toBe(true);
		expect(hasRepairableDamage(note)).toBe(true);
	});

	it('gets its id, author, range and reply back from a <br> marker', () => {
		const r = repairTableCellComments(BR_CELL);
		expect(r.converted).toBe(1);
		const [c] = parseDocument(r.updated).comments;
		expect(c?.id).toBe('9v77owhe');
		expect(c?.author).toBe('Charles');
		expect(c?.range).toBe('closed');
		expect(c?.body).toBe('what is this column?');
		expect(c?.replies.map((x) => x.author)).toEqual(['claude']);
		// The cell holds a one-line lean marker, and every table line is a row.
		const rows = r.updated.slice(
			0,
			r.updated.indexOf('<!-- annoteca:store'),
		);
		expect(rows).toContain(
			`| One | ${serializeLeanMarker('clarify', '9v77owhe')} Applied in<!-- /annoteca 9v77owhe --> |`,
		);
		expect(tableCellProblems(r.updated)).toEqual([]);
	});

	it('mends the table when the marker had real line breaks', () => {
		const r = repairTableCellComments(NL_CELL);
		expect(r.converted).toBe(1);
		const table = r.updated.slice(0, r.updated.indexOf('\n\n'));
		for (const line of table.split('\n'))
			expect(line.startsWith('|')).toBe(true);
		expect(parseDocument(r.updated).comments[0]?.body).toBe('a question');
	});

	it('runs as part of the repair command, once', () => {
		const once = repairComments(BR_CELL);
		expect(once.converted).toBe(1);
		expect(repairComments(once.updated).converted).toBe(0);
	});

	it('leaves a comment outside a table alone', () => {
		const note =
			'Prose <!-- annoteca/note: x\n[id=bbbbbbbb]\n[author=a]\n--> here.\n';
		expect(tableCellProblems(note)).toEqual([]);
		expect(repairTableCellComments(note).converted).toBe(0);
	});
});

describe('a lean comment in a table row and the note’s storage', () => {
	// An inline note that also holds a lean comment in a cell.
	const lean = serializeLeanMarker('clarify', 'cccccccc');
	const mixed = writeStoreRegion(
		'Prose <!-- annoteca/note: inline\n[id=dddddddd]\n[author=a]\n--> here.\n\n' +
			HEAD +
			`| One | ${lean} cell |\n`,
		[
			{
				id: 'cccccccc',
				category: 'clarify',
				body: 'in a cell',
				replies: [],
			},
		],
	);

	it('does not make an inline note an end-of-file note', () => {
		expect(resolveStorageModeForNewComment(mixed, undefined, 'eof')).toBe(
			'inline',
		);
		const onlyCell = writeStoreRegion(HEAD + `| One | ${lean} cell |\n`, [
			{ id: 'cccccccc', category: 'clarify', body: 'x', replies: [] },
		]);
		// With nothing else in the note, the default decides.
		expect(
			resolveStorageModeForNewComment(onlyCell, undefined, 'inline'),
		).toBe('inline');
	});

	it('stays lean when the note is converted to inline storage', () => {
		const r = convertFileToInline(mixed);
		expect(r.updated).toContain(`| One | ${lean} cell |`);
		expect(parseStore(r.updated).map((e) => e.comment.id)).toEqual([
			'cccccccc',
		]);
		expect(
			parseAll(r.updated).find((c) => c.id === 'cccccccc'),
		).toBeDefined();
	});
});

describe('the repair, at the edges', () => {
	it('gives a duplicated id a fresh one, so no thread is orphaned', () => {
		const note =
			HEAD +
			'| x | <!-- annoteca/note: first\n[id=aaaaaaaa]\n--> |\n' +
			'| y | <!-- annoteca/note: second\n[id=aaaaaaaa]\n--> |\n';
		const r = repairTableCellComments(note);
		const doc = parseDocument(r.updated);
		expect(doc.comments.map((c) => c.body).sort()).toEqual([
			'first',
			'second',
		]);
		expect(doc.orphanedStore).toEqual([]);
		expect(new Set(doc.comments.map((c) => c.id)).size).toBe(2);
	});

	it('keeps a <br> that is part of the comment’s own text', () => {
		const note =
			HEAD +
			'| x | <!-- annoteca/note: keep `<br>` here<br>[id=aaaaaaaa]<br>[author=a]<br>--> |\n';
		const r = repairTableCellComments(note);
		const [c] = parseDocument(r.updated).comments;
		expect(c?.body).toBe('keep `<br>` here');
		expect(c?.author).toBe('a');
	});
});

describe('table rows, more edges', () => {
	it('does not hang on a note that starts with a blank line', () => {
		const note = '\n| a | b |\n|---|---|\n';
		expect(inTableRow(note, 3)).toBe(true);
		expect(inTableRow('\n| a pipe paragraph', 3)).toBe(false);
	});

	it('gives a <br> comment a fresh id when another comment has its id', () => {
		const full =
			'Para <!-- annoteca/note: x\n[id=abcdefgh]\n[author=a]\n--> here.\n\n';
		const note =
			full +
			HEAD +
			'| x | <!-- annoteca/note: copy<br>[id=abcdefgh]<br>[author=a]<br>--> |\n';
		const r = repairTableCellComments(note);
		const ids = parseDocument(r.updated).comments.map((c) => c.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	it('keeps a marker at the start of a body row on the row', () => {
		const note = '| h | i |\n|---|---|\n| a | b |\n| c | d |\n';
		expect(inCell(note, note.indexOf('| c'))).toBe(note.indexOf('c |'));
	});
});

describe('tables without outer pipes', () => {
	const bare = 'a | b\n--- | ---\nc | d\n';

	it('are tables, and a pipe paragraph still is not', () => {
		expect(inTableRow(bare, bare.indexOf('c'))).toBe(true);
		expect(inTableRow(bare, 0)).toBe(true);
		expect(inTableRow('x | y is a paragraph', 0)).toBe(false);
	});

	it('keep a marker at a row start on the row, at the end of the first cell', () => {
		const row = bare.indexOf('c');
		expect(inCell(bare, row)).toBe(row + 1);
		// Anywhere past the start, the marker stays where it was asked for.
		expect(inCell(bare, bare.indexOf('d'))).toBe(bare.indexOf('d'));
	});

	it('get the full marker in a row repaired', () => {
		const note =
			'a | b\n--- | ---\nc | <!-- annoteca/note: q\n[id=aaaaaaaa]\n--> d\n';
		const r = repairTableCellComments(note);
		expect(r.converted).toBe(1);
		expect(
			r.updated.startsWith(
				`a | b\n--- | ---\nc | ${serializeLeanMarker('note', 'aaaaaaaa')} d\n`,
			),
		).toBe(true);
	});
});

describe('the end of a table', () => {
	const table = '| h | i |\n|---|---|\n| a | b |\n';

	it.each(['- item a | b', '# Heading a | b', '> quote a | b'])(
		'is not continued by %s',
		(line) => {
			const note = `${table}${line}\n`;
			expect(inTableRow(note, note.indexOf(line) + 2)).toBe(false);
		},
	);

	it('still reads a quoted table and a `- | -` delimiter', () => {
		const quoted = '> | h | i |\n> | - | - |\n> | a | b |\n';
		expect(inTableRow(quoted, quoted.indexOf('a'))).toBe(true);
	});
});

describe('the first cell of a row without a leading pipe', () => {
	const head = 'h | i\n--- | ---\n';

	it('ends at a pipe that is not escaped, in code or not', () => {
		const escaped = `${head}a \\| b | c\n`;
		const row = escaped.indexOf('a \\|');
		expect(inCell(escaped, row)).toBe(escaped.indexOf(' | c'));
		// GFM splits cells on a pipe inside backticks too.
		const code = `${head}\`x|y\` | c\n`;
		expect(inCell(code, code.indexOf('`x'))).toBe(code.indexOf('|y'));
		// An unclosed backtick does not hide the pipe.
		const open = `${head}\`a | b\n`;
		expect(inCell(open, open.indexOf('`a'))).toBe(open.indexOf(' | b'));
	});
});
