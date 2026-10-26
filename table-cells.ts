// Comments in table rows.
//
// A full inline marker spans several lines (its id, date, author and thread
// lines). A table row is one line, and markdown ends the table at the first
// line that is not a row, so a full marker written into a cell breaks the
// table there and shows the rest of it as text. Obsidian's table editor can
// later turn those line breaks into `<br>`, which mends the row but not the
// comment: the trailing lines are no longer lines, so the id, author, range
// flag and thread all read as body text, and the comment loses its identity.
//
// So a comment in a table row is written as a lean marker
// (`<!-- annoteca/<category>: [id=...] -->`, one line) with its body and
// thread in the end-of-file store, whatever the note's storage mode: when it
// is created, and the first time an existing one-line comment in a cell is
// rewritten (cellRewrite). The store holds an addressed comment's original
// text as JSON, so the accept/revise/reject flow works in a cell too. Those
// markers do not decide the note's mode (document.ts), and converting the note
// to inline storage leaves them as they are.
//
// A one-line full marker in a cell (an import, a hand-written comment) is
// fine as it is: it reads correctly and the row holds. Only one that spans
// lines, or whose lines became `<br>`, is reported and repaired.
//
// Pure: no Obsidian dependency.

import type { ImportResult } from './imports';
import {
	generateId,
	parseAll,
	serializeLeanMarker,
	type MalformedMarker,
} from './parser';
import { isLeanMarker } from './document';
import { inTableRow } from './table-row';
import {
	parseStore,
	toStored,
	writeStoreRegion,
	type StoredComment,
} from './store';
import type { Comment } from './types';

// A `<br>` (in the spellings HTML allows) standing where a line break between
// a marker's lines was: right before a trailing line, or before the marker's
// closing `-->`. A `<br>` anywhere else is the comment's own text and stays.
const BR_SEPARATOR_RE =
	/<br\s*\/?>(?=\s*(?:\[(?:id|date|author|source|anchor|range|reply|addressed|resolved)[\s=]|-->))/gi;

// Whether a full marker in a row damages it: its lines end the row, or they
// became `<br>` and its trailing lines read as text.
function damaging(raw: string): boolean {
	BR_SEPARATOR_RE.lastIndex = 0;
	return raw.includes('\n') || BR_SEPARATOR_RE.test(raw);
}

const REASON =
	'This comment is written into a table row as a full marker. Its line breaks end the row and break the table, or, once they turn into `<br>`, its id and thread read as text. Run "Repair comments written inside other comments in this note" to keep it in the cell as a one-line marker with its text at the end of the note.';

function damagedInRows(content: string): Comment[] {
	return parseAll(content).filter(
		(c) =>
			!isLeanMarker(c) &&
			inTableRow(content, c.marker.start) &&
			damaging(content.slice(c.marker.start, c.marker.end)),
	);
}

// Full markers that damage a table row, reported alongside the other marker
// problems. Kind 'malformed': nothing about them makes removing another
// comment unsafe.
export function tableCellProblems(content: string): MalformedMarker[] {
	return damagedInRows(content).map((c) => ({
		start: c.marker.start,
		excerpt: content.slice(
			c.marker.start,
			Math.min(content.length, c.marker.start + 120),
		),
		reason: REASON,
		kind: 'malformed',
	}));
}

// Ids for comments moving to the store: their own, unless another comment in
// the note, another store entry, or an earlier comment in this batch already
// has it, which would join two threads under one id. `hidden` are ids the
// note's parse cannot see: those of markers whose lines became `<br>`, where
// `[id=...]` reads as body text until the marker is read again.
function idIssuer(
	content: string,
	hidden: readonly string[] = [],
): (wanted: string | undefined) => string {
	const stored = new Set(parseStore(content).map((e) => e.comment.id));
	const count = new Map<string, number>();
	const ids = [
		...parseAll(content).flatMap((c) => (c.id === undefined ? [] : [c.id])),
		...hidden,
	];
	for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
	const issued = new Set<string>();
	return (wanted) => {
		let id = wanted;
		if (
			id === undefined ||
			stored.has(id) ||
			issued.has(id) ||
			(count.get(id) ?? 0) > 1
		) {
			do id = generateId();
			while (count.has(id) || stored.has(id) || issued.has(id));
		}
		issued.add(id);
		return id;
	};
}

// Rewrite every full marker that damages a table row as a lean marker plus a
// store entry. A marker whose lines became `<br>` is read with those `<br>`
// as line breaks again, so its id, author, range flag and thread come back.
// `converted` is how many comments moved.
//
// Repeated until nothing moves: a row below a broken one is cut off from the
// table's delimiter row, so its own damage shows only once the one above it
// is mended. Each pass moves at least one comment, so the bound is the number
// of comments in the note.
export function repairTableCellComments(content: string): ImportResult {
	let updated = content;
	let converted = 0;
	for (let pass = 0; pass <= parseAll(content).length; pass++) {
		const r = repairPass(updated);
		if (r.converted === 0) break;
		updated = r.updated;
		converted += r.converted;
	}
	return { updated, converted };
}

function repairPass(content: string): ImportResult {
	const damaged = damagedInRows(content);
	if (damaged.length === 0) return { updated: content, converted: 0 };
	const reads = damaged.map((c) => ({
		c,
		read: parseAll(
			content
				.slice(c.marker.start, c.marker.end)
				.replace(BR_SEPARATOR_RE, '\n'),
		)[0],
	}));
	const issue = idIssuer(
		content,
		reads.flatMap(({ c, read }) =>
			c.id === undefined && read?.id !== undefined ? [read.id] : [],
		),
	);
	const edits: { start: number; end: number; text: string }[] = [];
	const added: StoredComment[] = [];
	for (const { c, read } of reads) {
		if (read === undefined || read.category !== c.category) continue;
		const id = issue(read.id);
		added.push(toStored(id, { ...read, id }));
		edits.push({
			start: c.marker.start,
			end: c.marker.end,
			text: serializeLeanMarker(c.category, id),
		});
	}
	if (edits.length === 0) return { updated: content, converted: 0 };
	let prose = content;
	for (const e of [...edits].reverse())
		prose = prose.slice(0, e.start) + e.text + prose.slice(e.end);
	return {
		updated: writeStoreRegion(prose, [
			...parseStore(content).map((e) => e.comment),
			...added,
		]),
		converted: edits.length,
	};
}

export function hasRepairableTableCell(content: string): boolean {
	return damagedInRows(content).length > 0;
}

// What rewriting an inline comment at `at` should write instead of its full
// marker, or undefined when it is not in a table row and the full marker is
// fine. In a row: a lean marker, and the store entries with this comment's
// added (the full marker it would otherwise write spans lines and breaks the
// row). Callers splice `marker` over the old marker and write `entries` with
// withStoreRewrite.
export function cellRewrite(
	content: string,
	at: number,
	next: Comment,
): { marker: string; entries: StoredComment[] } | undefined {
	if (!inTableRow(content, at)) return undefined;
	const id = idIssuer(content)(next.id);
	return {
		marker: serializeLeanMarker(next.category, id),
		entries: [
			...parseStore(content).map((e) => e.comment),
			toStored(id, { ...next, id }),
		],
	};
}
