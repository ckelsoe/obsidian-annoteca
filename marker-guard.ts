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

import { SpanIndex } from './span-index';
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
import { scanStoreEntries } from './store';

export interface GuardRange {
	readonly start: number;
	readonly end: number;
	// The end-of-file comment store holds the bodies and threads of lean
	// markers: deleting it with the text around it would empty them.
	readonly kind: 'opener' | 'closer' | 'store';
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
			// The cursor for each change, when there are several.
			readonly cursors: number[];
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
	// Indexed: a replace-all is one transaction with a change per match, and
	// asking every range for every change was quadratic. A change can only
	// cut a range it overlaps, or (an insertion) one it sits strictly in.
	const index = new SpanIndex(ranges, (r) => r);
	for (const c of changes) {
		for (const r of index.overlapping(c.from, Math.max(c.to, c.from + 1))) {
			const whole = r.start >= c.from && r.end <= c.to;
			if (whole) continue;
			// A store block is guarded like an opener: its `<!--` and `-->`
			// are protected, and its JSON between them can be edited by hand
			// where it shows raw.
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
	// One cursor per change, after the text typed for it.
	const cursors: number[] = [];
	const out: GuardChange[] = [];
	for (const c of changes) {
		const inside = index
			.overlapping(c.from, c.to)
			.filter((r) => r.start >= c.from && r.end <= c.to);
		if (inside.length === 0) {
			out.push(c);
			onlyMarkers = false;
			delta += c.insert.length - (c.to - c.from);
			cursor = c.from + delta + (c.to - c.from);
			cursors.push(cursor);
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
		const stores = inside
			.filter((r) => r.kind === 'store')
			.map((r) => doc.slice(r.start, r.end))
			.join('\n\n');
		// The one space an inline opener is followed by, when text follows.
		const gap = openers !== '' && c.insert !== '' ? ' ' : '';
		const body = `${openers}${gap}${c.insert}${closers}`;
		// The store stays the last thing, a blank line after the prose.
		const insert =
			stores === ''
				? body
				: body === ''
					? stores
					: `${body}\n\n${stores}`;
		out.push({ from: c.from, to: c.to, insert });
		const newFrom = c.from + delta;
		delta += insert.length - (c.to - c.from);
		cursor = newFrom + openers.length + gap.length + c.insert.length;
		cursors.push(cursor);
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
	return { kind: 'rewritten', changes: out, cursor, cursors };
}

export function guardRangesOf(
	comments: readonly Comment[],
	stores: readonly { start: number; end: number }[] = [],
): GuardRange[] {
	const out: GuardRange[] = stores.map((r) => ({
		start: r.start,
		end: r.end,
		kind: 'store' as const,
	}));
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
	storeField: StateField<readonly { start: number; end: number }[]>,
	onRefused: () => void,
): Extension {
	return EditorState.transactionFilter.of((tr) => {
		if (!tr.docChanged || !isGuardedEdit(tr)) return tr;
		const ranges = guardRangesOf(
			tr.startState.field(field),
			tr.startState.field(storeField),
		);
		if (ranges.length === 0) return tr;
		const changes: GuardChange[] = [];
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			changes.push({ from: fromA, to: toA, insert: inserted.toString() });
		});
		// Ordinary typing touches no marker: settle that without building the
		// whole document as a string on every keystroke.
		const index = new SpanIndex(ranges, (r) => r);
		const near = changes.some((c) => index.some(c.from - 1, c.to + 1));
		if (!near) return tr;
		const doc = tr.startState.doc.toString();
		// Each store block on its own, so each one's delimiters are guarded.
		const blocks = scanStoreEntries(doc).map((b) => ({
			start: b.start,
			end: b.end,
			kind: 'store' as const,
		}));
		const result = guardEdit(
			doc,
			[...ranges.filter((r) => r.kind !== 'store'), ...blocks],
			changes,
			tr.isUserEvent('delete.backward'),
		);
		if (result.kind === 'unchanged') return tr;
		const userEvent = tr.annotation(Transaction.userEvent);
		// Several cursors keep their places; one moves as the result says.
		const multi = tr.startState.selection.ranges.length > 1;
		if (result.kind === 'refused') {
			onRefused();
			const spec: TransactionSpec = {
				selection: multi
					? tr.startState.selection
					: EditorSelection.cursor(result.cursor),
				scrollIntoView: true,
			};
			return spec;
		}
		const changeSet = ChangeSet.of(result.changes, doc.length);
		const spec: TransactionSpec = {
			changes: changeSet,
			// Each cursor after the text typed for it, as plain typing leaves
			// them: mapping the old selections would leave that text selected.
			selection:
				multi &&
				result.cursors.length === tr.startState.selection.ranges.length
					? EditorSelection.create(
							result.cursors.map((p) =>
								EditorSelection.cursor(p),
							),
							tr.startState.selection.mainIndex,
						)
					: multi
						? tr.startState.selection.map(changeSet, 1)
						: EditorSelection.cursor(result.cursor),
			scrollIntoView: true,
			...(userEvent !== undefined && { userEvent }),
		};
		return spec;
	});
}
