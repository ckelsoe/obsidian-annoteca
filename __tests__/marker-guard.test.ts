// Anchoring hardening, part A: edits around a marker keep the comment.

import { guardEdit, guardRangesOf } from '../marker-guard';
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
