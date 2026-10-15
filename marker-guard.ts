// Anchoring hardening, part A: a comment survives the edits made around it.
//
// A comment is its marker. Before this, selecting a passage that held one and
// typing over it, pasting over it, or deleting it took the marker with it, and
// the comment, its thread and its history were gone with no sign. A single
// Backspace next to a marker icon deleted the whole comment the same way.
//
// So, for the user's own typing, pasting and deleting (never for a cut, which
// carries the marker to the clipboard and lets a paste move the comment with
// its text, never for undo or redo, and never for a plugin's or Annoteca's own
// writes, which carry no user event):
//   - text replaced or deleted around a marker keeps the marker: openers go
//     in front of the new text, closers after it, so the comment now covers
//     what was typed in place of its passage;
//   - a delete that would remove nothing but markers (Backspace or Delete on
//     an icon) is refused, and the cursor steps over the icon instead.
// Deleting a comment is done from its menu, which says what it removes.

import {
	ChangeSet,
	EditorSelection,
	EditorState,
	Transaction,
	type Extension,
	type TransactionSpec,
	type StateField,
} from '@codemirror/state';
import type { Comment } from './types';

export interface GuardRange {
	readonly start: number;
	readonly end: number;
	readonly kind: 'opener' | 'closer';
}

export interface GuardChange {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
}

export type GuardResult =
	| { readonly kind: 'unchanged' }
	| {
			readonly kind: 'rewritten';
			readonly changes: GuardChange[];
			// Where the cursor goes, in the document after the changes.
			readonly cursor: number;
	  }
	| {
			readonly kind: 'refused';
			// Where the cursor goes, in the unchanged document.
			readonly cursor: number;
	  };

// The edit as it should be applied, given the markers in the document before
// it. `backward`: a Backspace, which steps the cursor to the icon's left.
export function guardEdit(
	doc: string,
	ranges: readonly GuardRange[],
	changes: readonly GuardChange[],
	backward: boolean,
): GuardResult {
	// An edit that cuts into a marker's `<!--` or `-->`, or into a closer,
	// without taking the whole marker would break the marker and spill it
	// into the prose. Refused, the cursor stepping over the marker. Editing
	// the marker's own text between its delimiters (by hand, where markers
	// show raw) is left alone.
	for (const c of changes) {
		for (const r of ranges) {
			const whole = r.start >= c.from && r.end <= c.to;
			if (whole) continue;
			const zones: { a: number; b: number }[] =
				r.kind === 'closer'
					? [{ a: r.start, b: r.end }]
					: [
							{ a: r.start, b: r.start + 4 },
							{ a: r.end - 3, b: r.end },
						];
			// A deletion overlapping a zone, or an insertion strictly inside one.
			const cuts = zones.some(({ a, b }) =>
				c.to > c.from
					? c.from < b && c.to > a
					: c.from > a && c.from < b,
			);
			if (cuts)
				return {
					kind: 'refused',
					cursor: backward ? r.start : r.end,
				};
		}
	}
	let touched = false;
	let onlyMarkers = true;
	let delta = 0;
	let cursor = 0;
	const out: GuardChange[] = [];
	for (const c of changes) {
		const inside = ranges
			.filter((r) => r.start >= c.from && r.end <= c.to)
			.sort((a, b) => a.start - b.start);
		if (inside.length === 0) {
			out.push(c);
			onlyMarkers = false;
			delta += c.insert.length - (c.to - c.from);
			cursor = c.from + delta + (c.to - c.from);
			continue;
		}
		touched = true;
		// What the change removes besides markers.
		let rest = '';
		let at = c.from;
		for (const r of inside) {
			rest += doc.slice(at, r.start);
			at = r.end;
		}
		rest += doc.slice(at, c.to);
		if (rest.trim() !== '' || c.insert !== '') onlyMarkers = false;
		const openers = inside
			.filter((r) => r.kind === 'opener')
			.map((r) => doc.slice(r.start, r.end))
			.join('');
		const closers = inside
			.filter((r) => r.kind === 'closer')
			.map((r) => doc.slice(r.start, r.end))
			.join('');
		// The one space an inline opener is followed by, when text follows.
		const gap = openers !== '' && c.insert !== '' ? ' ' : '';
		const insert = `${openers}${gap}${c.insert}${closers}`;
		out.push({ from: c.from, to: c.to, insert });
		const newFrom = c.from + delta;
		delta += insert.length - (c.to - c.from);
		cursor = newFrom + openers.length + gap.length + c.insert.length;
	}
	if (!touched) return { kind: 'unchanged' };
	if (onlyMarkers) {
		const first = changes[0];
		const last = changes[changes.length - 1];
		return {
			kind: 'refused',
			cursor: backward ? (first?.from ?? 0) : (last?.to ?? 0),
		};
	}
	return { kind: 'rewritten', changes: out, cursor };
}

export function guardRangesOf(comments: readonly Comment[]): GuardRange[] {
	const out: GuardRange[] = [];
	for (const c of comments) {
		out.push({ start: c.marker.start, end: c.marker.end, kind: 'opener' });
		if (c.closer)
			out.push({
				start: c.closer.start,
				end: c.closer.end,
				kind: 'closer',
			});
	}
	return out;
}

// The user edits this applies to. A cut is left alone on purpose: the marker
// goes to the clipboard with the text, and pasting it moves the comment along.
function isGuardedEdit(tr: Transaction): boolean {
	if (tr.isUserEvent('delete.cut')) return false;
	if (tr.isUserEvent('input.type.compose')) return false;
	return tr.isUserEvent('input') || tr.isUserEvent('delete');
}

export function markerGuard(
	field: StateField<Comment[]>,
	onRefused: () => void,
): Extension {
	return EditorState.transactionFilter.of((tr) => {
		if (!tr.docChanged || !isGuardedEdit(tr)) return tr;
		const ranges = guardRangesOf(tr.startState.field(field));
		if (ranges.length === 0) return tr;
		const changes: GuardChange[] = [];
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			changes.push({ from: fromA, to: toA, insert: inserted.toString() });
		});
		const doc = tr.startState.doc.toString();
		const result = guardEdit(
			doc,
			ranges,
			changes,
			tr.isUserEvent('delete.backward'),
		);
		if (result.kind === 'unchanged') return tr;
		const userEvent = tr.annotation(Transaction.userEvent);
		if (result.kind === 'refused') {
			onRefused();
			const spec: TransactionSpec = {
				selection: EditorSelection.cursor(result.cursor),
				scrollIntoView: true,
			};
			return spec;
		}
		const spec: TransactionSpec = {
			changes: ChangeSet.of(result.changes, doc.length),
			selection: EditorSelection.cursor(result.cursor),
			scrollIntoView: true,
			...(userEvent !== undefined && { userEvent }),
		};
		return spec;
	});
}
