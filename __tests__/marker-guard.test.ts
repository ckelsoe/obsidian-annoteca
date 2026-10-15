// Anchoring hardening, part A: edits around a marker keep the comment.

import {
	EditorSelection,
	EditorState,
	StateField,
	Transaction,
} from '@codemirror/state';
import { guardEdit, guardRangesOf, markerGuard } from '../marker-guard';
import { storeRegions, writeStoreRegion } from '../store';
import type { Comment } from '../types';
import { parseDocument } from '../document';

const M = '<!-- annoteca/tone: x\n[id=aaaa1111]\n-->';

function setup(doc: string) {
	return { doc, ranges: guardRangesOf(parseDocument(doc).comments) };
}

function apply(
	doc: string,
	changes: { from: number; to: number; insert: string }[],
): string {
	return [...changes]
		.sort((a, b) => b.from - a.from)
		.reduce((s, c) => s.slice(0, c.from) + c.insert + s.slice(c.to), doc);
}

describe('guardEdit', () => {
	it('keeps a marker when text around it is typed over', () => {
		const { doc, ranges } = setup(`Alpha ${M} beta gamma.`);
		const from = 0;
		const to = doc.indexOf('beta') + 4;
		const r = guardEdit(doc, ranges, [{ from, to, insert: 'X' }], false);
		if (r.kind !== 'rewritten') throw new Error(r.kind);
		const out = apply(doc, r.changes);
		expect(out).toBe(`${M} X gamma.`);
		expect(out.slice(0, r.cursor)).toBe(`${M} X`);
	});

	it('keeps an opener in front and a closer after the new text', () => {
		const C = '<!-- /annoteca aaaa1111 -->';
		const { doc, ranges } = setup(`Start ${M} old words${C} end.`);
		const from = doc.indexOf('Start');
		const to = doc.indexOf(' end');
		const r = guardEdit(doc, ranges, [{ from, to, insert: 'new' }], false);
		if (r.kind !== 'rewritten') throw new Error(r.kind);
		expect(apply(doc, r.changes)).toBe(`${M} new${C} end.`);
	});

	it('keeps the comment when its passage is deleted outright', () => {
		const { doc, ranges } = setup(`Keep. ${M} gone text. Tail.`);
		const from = doc.indexOf(M);
		const to = doc.indexOf(' Tail');
		const r = guardEdit(doc, ranges, [{ from, to, insert: '' }], false);
		if (r.kind !== 'rewritten') throw new Error(r.kind);
		expect(apply(doc, r.changes)).toBe(`Keep. ${M} Tail.`);
	});

	it('refuses deleting nothing but a marker, stepping over it', () => {
		const { doc, ranges } = setup(`Alpha ${M} beta.`);
		const s = doc.indexOf(M);
		const e = s + M.length;
		expect(
			guardEdit(doc, ranges, [{ from: s, to: e, insert: '' }], true),
		).toEqual({ kind: 'refused', cursor: s });
		expect(
			guardEdit(doc, ranges, [{ from: s - 1, to: e, insert: '' }], false),
		).toEqual({ kind: 'refused', cursor: e });
	});

	it('refuses a Backspace into the end of a marker', () => {
		const { doc, ranges } = setup(`Alpha ${M} beta.`);
		const e = doc.indexOf(M) + M.length;
		expect(
			guardEdit(doc, ranges, [{ from: e - 1, to: e, insert: '' }], true),
		).toEqual({ kind: 'refused', cursor: doc.indexOf(M) });
	});

	it('refuses typing into a delimiter, but allows editing the body by hand', () => {
		const { doc, ranges } = setup(`Alpha ${M} beta.`);
		const s = doc.indexOf(M);
		expect(
			guardEdit(
				doc,
				ranges,
				[{ from: s + 2, to: s + 2, insert: 'z' }],
				false,
			).kind,
		).toBe('refused');
		const body = doc.indexOf('x\n');
		expect(
			guardEdit(
				doc,
				ranges,
				[{ from: body, to: body + 1, insert: 'better' }],
				false,
			).kind,
		).toBe('unchanged');
	});

	it('leaves edits that do not touch a marker alone', () => {
		const { doc, ranges } = setup(`Alpha ${M} beta.`);
		expect(
			guardEdit(doc, ranges, [{ from: 0, to: 5, insert: 'Omega' }], false)
				.kind,
		).toBe('unchanged');
		const after = doc.indexOf(M) + M.length;
		expect(
			guardEdit(
				doc,
				ranges,
				[{ from: after, to: after, insert: '!' }],
				false,
			).kind,
		).toBe('unchanged');
	});
});

describe('guardEdit and the end-of-file store', () => {
	it('keeps the store when everything is selected and typed over', () => {
		const lean = '<!-- annoteca/tone: [id=aaaa1111] -->';
		const doc = writeStoreRegion(`Prose ${lean} here.\n`, [
			{ id: 'aaaa1111', category: 'tone', body: 'the body', replies: [] },
		]);
		const ranges = guardRangesOf(
			parseDocument(doc).comments,
			storeRegions(doc),
		);
		const r = guardEdit(
			doc,
			ranges,
			[{ from: 0, to: doc.length, insert: 'X' }],
			false,
		);
		if (r.kind !== 'rewritten') throw new Error(r.kind);
		const out = apply(doc, r.changes);
		expect(parseDocument(out).comments[0]?.body).toBe('the body');
		expect(out.startsWith(`${lean} X\n\n<!-- annoteca:store`)).toBe(true);
	});

	it('refuses an edit that cuts into the store, allows one inside it', () => {
		const doc = writeStoreRegion('Prose.\n', [
			{ id: 'aaaa1111', category: 'tone', body: 'the body', replies: [] },
		]);
		const ranges = guardRangesOf([], storeRegions(doc));
		const start = doc.indexOf('<!-- annoteca:store');
		expect(
			guardEdit(
				doc,
				ranges,
				[{ from: 2, to: start + 5, insert: '' }],
				true,
			).kind,
		).toBe('refused');
		// Deleting just the store's first character would unhinge it.
		expect(
			guardEdit(
				doc,
				ranges,
				[{ from: start, to: start + 1, insert: '' }],
				false,
			).kind,
		).toBe('refused');
		const inBody = doc.indexOf('the body');
		expect(
			guardEdit(
				doc,
				ranges,
				[{ from: inBody, to: inBody + 3, insert: 'a' }],
				false,
			).kind,
		).toBe('unchanged');
	});
});

describe('markerGuard in a CodeMirror state', () => {
	function stateFor(doc: string, selection: EditorSelection) {
		const comments = StateField.define<Comment[]>({
			create: (st) => parseDocument(st.doc.toString()).comments,
			update: (v, tr) =>
				tr.docChanged
					? parseDocument(tr.state.doc.toString()).comments
					: v,
		});
		const stores = StateField.define<{ start: number; end: number }[]>({
			create: (st) => storeRegions(st.doc.toString()),
			update: (v) => v,
		});
		return EditorState.create({
			doc,
			selection,
			extensions: [
				EditorState.allowMultipleSelections.of(true),
				comments,
				stores,
				markerGuard(comments, stores, () => undefined),
			],
		});
	}

	it('keeps every cursor when one of several edits covers a marker', () => {
		const doc = `Alpha ${M} beta. Other words.`;
		const a = doc.indexOf('Alpha');
		const b = doc.indexOf(' beta');
		const o = doc.indexOf('Other');
		const state = stateFor(
			doc,
			EditorSelection.create([
				EditorSelection.range(a, b),
				EditorSelection.range(o, o + 5),
			]),
		);
		const tr = state.update(state.replaceSelection('X'), {
			annotations: Transaction.userEvent.of('input.type'),
		});
		expect(tr.state.doc.toString()).toBe(`${M} X beta. X words.`);
		expect(tr.state.selection.ranges).toHaveLength(2);
		// Both cursors sit after what was typed, so the next key appends.
		expect(tr.state.selection.ranges.every((r) => r.empty)).toBe(true);
		const next = tr.state.update(tr.state.replaceSelection('Y'), {
			annotations: Transaction.userEvent.of('input.type'),
		});
		expect(next.state.doc.toString()).toBe(`${M} XY beta. XY words.`);
	});

	it('leaves a programmatic write alone', () => {
		const doc = `Alpha ${M} beta.`;
		const state = stateFor(doc, EditorSelection.single(0));
		const tr = state.update({
			changes: { from: 0, to: doc.length, insert: '' },
		});
		expect(tr.state.doc.toString()).toBe('');
	});
});
