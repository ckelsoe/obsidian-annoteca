// No path may write a new marker or closer inside something Annoteca already
// wrote (a marker, a closer, an end-of-file store entry) or inside the note
// properties. Each case below is a reproduction from the 2026-10-18 sweep
// that found this class of defect in the composer, the importer, the
// placement repair, the API's promote and the closer planner.

import { convertGenericHtmlComments, convertNativeComments } from '../imports';
import { enclosingForbidden, insideForbidden } from '../forbidden';
import {
	planSafeMarkerInsert,
	repairMarkerPlacement,
} from '../marker-placement';
import { parseAll, serialize, serializeCloser } from '../parser';
import { frontmatterEnd, planCloser } from '../range-placement';
import { parseStore, scanStoreEntries, writeStoreRegion } from '../store';

const STORED = {
	id: 'ssss1111',
	category: 'clarify',
	body: 'stored %%keep%% body',
	replies: [],
};
const withStore = (prose: string): string => writeStoreRegion(prose, [STORED]);

// A marker whose body runs onto a heading line: planMarkerInsert sends a
// multi-line marker on a heading line to the line start, which is inside it.
const HEADING_INSIDE = '<!-- annoteca/clarify: first\n# heading --> tail\n';

describe('the importer never converts inside protected text', () => {
	it('leaves %%...%% in the note properties alone', () => {
		const doc = '---\ntitle: %%hello%%\n---\nBody %%convert me%% text.';
		const r = convertNativeComments(doc, 'uncategorized');
		expect(r.updated.startsWith('---\ntitle: %%hello%%\n---\n')).toBe(true);
		expect(r.converted).toBe(1);
	});

	it('leaves %%...%% inside a store entry alone, keeping the entry whole', () => {
		const doc = withStore('Prose here.');
		const r = convertNativeComments(doc, 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
		expect(parseStore(r.updated).map((e) => e.comment.body)).toEqual([
			'stored %%keep%% body',
		]);
	});

	it('does not turn store entries or closers into ordinary comments', () => {
		const marker = serialize({
			id: 'aaaaaaaa',
			category: 'clarify',
			body: 'b',
		});
		const doc = withStore(
			`${marker} passage${serializeCloser('aaaaaaaa')} and <!-- a plain note -->`,
		);
		const r = convertGenericHtmlComments(doc, 'uncategorized');
		expect(r.converted).toBe(1);
		expect(scanStoreEntries(r.updated)).toHaveLength(1);
		expect(r.updated).toContain(serializeCloser('aaaaaaaa'));
	});
});

describe('the note properties count from offset 0', () => {
	const doc = '---\ntitle: x\n---\nBody.';
	it('treats the very start as inside the properties', () => {
		expect(insideForbidden(doc, 0)).toBe(true);
		expect(enclosingForbidden(doc, 0)).toEqual({
			start: 0,
			end: doc.indexOf('Body'),
		});
	});
	it('but not a note with no properties', () => {
		expect(insideForbidden('Body.', 0)).toBe(false);
	});
});

describe('planSafeMarkerInsert', () => {
	it('moves a placement that lands inside a marker to just before it', () => {
		const place = planSafeMarkerInsert(
			HEADING_INSIDE,
			HEADING_INSIDE.indexOf('tail'),
			true,
		);
		expect(place?.at).toBe(0);
	});

	it('moves a placement at the start of the properties to after them', () => {
		const doc = '---\ntitle: x\n---\nBody.';
		expect(planSafeMarkerInsert(doc, 0, true)?.at).toBe(
			doc.indexOf('Body'),
		);
	});
});

describe('placement repair never moves a marker into another', () => {
	it('leaves a marker whole when its repaired spot is inside another marker', () => {
		const second = serialize({
			id: 'bbbbbbbb',
			category: 'tone',
			body: 'second',
			date: '2026-10-17T10:16:12',
		});
		const doc = `<!-- annoteca/clarify: first\n# heading --> ${second} tail\n`;
		const before = parseAll(doc).map((c) => c.body);
		const r = repairMarkerPlacement(doc);
		expect(parseAll(r.updated).map((c) => c.body)).toEqual(before);
		expect(r.updated).toContain(second);
	});
});

describe('planCloser never lands in the comment store', () => {
	it('stops a range at the start of the store', () => {
		const doc = withStore('Prose here.');
		const storeAt = scanStoreEntries(doc)[0]?.start ?? -1;
		const plan = planCloser(doc, 0, storeAt + 10, []);
		expect(plan).toEqual({ kind: 'range', at: 'Prose here.'.length });
	});
});

describe('edges found by the second sweep', () => {
	it('stops a range starting exactly at a store entry before it', () => {
		const doc = withStore('Prose here.');
		const storeAt = scanStoreEntries(doc)[0]?.start ?? -1;
		expect(planCloser(doc, storeAt, storeAt + 10, [])).toEqual({
			kind: 'none',
		});
	});

	it('treats an empty properties block as properties', () => {
		const doc = '---\n---\nBody.';
		expect(insideForbidden(doc, 0)).toBe(true);
		expect(planSafeMarkerInsert(doc, 0, true)?.at).toBe(
			doc.indexOf('Body'),
		);
	});

	it('puts a marker after properties that end the note on its own line', () => {
		const doc = '---\ntitle: x\n---';
		const place = planSafeMarkerInsert(doc, doc.length, false);
		expect(place?.at).toBe(doc.length);
		expect(place?.before.startsWith('\n')).toBe(true);
	});
});

describe('edges found by the third sweep', () => {
	it('ends empty properties at their own closing line, not a later rule', () => {
		const doc = '---\n---\nBody\n\n---\nTail';
		expect(frontmatterEnd(doc)).toBe(8);
		expect(insideForbidden(doc, doc.indexOf('Body') + 2)).toBe(false);
	});

	const UNCLOSED = 'Before.\n\n<!-- annoteca/clarify: unfinished\nBody text';

	it('treats the span an unclosed opener hides as protected', () => {
		const opener = UNCLOSED.indexOf('<!--');
		const inBody = UNCLOSED.indexOf('Body') + 2;
		expect(insideForbidden(UNCLOSED, inBody)).toBe(true);
		expect(planSafeMarkerInsert(UNCLOSED, inBody, true)?.at).toBe(opener);
	});

	it('stops a range at an unclosed opener, and gives one inside it no closer', () => {
		const opener = UNCLOSED.indexOf('<!--');
		expect(planCloser(UNCLOSED, 0, UNCLOSED.length, [])).toEqual({
			kind: 'range',
			at: 'Before.'.length,
		});
		const inBody = UNCLOSED.indexOf('Body');
		expect(planCloser(UNCLOSED, inBody, inBody + 4, [])).toEqual({
			kind: 'none',
		});
		expect(opener).toBeGreaterThan(0);
	});

	it('writes the store before an unclosed opener that runs to the end', () => {
		const out = writeStoreRegion(UNCLOSED, [STORED]);
		expect(out.indexOf('<!-- annoteca:store')).toBeLessThan(
			out.indexOf('<!-- annoteca/clarify: unfinished'),
		);
		expect(parseStore(out).map((e) => e.comment.id)).toEqual([STORED.id]);
		// The stray opener does not swallow the entry.
		expect(parseAll(out)).toEqual([]);
		// A fixed point, like every other store rebuild.
		expect(writeStoreRegion(out, [STORED])).toBe(out);
	});
});

describe('edges found by the fourth sweep', () => {
	it('counts the end of the note as inside an opener that runs to it', () => {
		const doc = 'Before\n\n<!-- annoteca/clarify: unfinished';
		expect(insideForbidden(doc, doc.length)).toBe(true);
		expect(planSafeMarkerInsert(doc, doc.length, true)?.at).toBe(
			doc.indexOf('<!--'),
		);
	});

	const QUOTED_PROPS =
		'---\ntitle: "<!-- annoteca/clarify: unfinished"\n---\nBody.';

	it('never moves the store into the properties', () => {
		const out = writeStoreRegion(QUOTED_PROPS, [STORED]);
		expect(
			out.startsWith(
				'---\ntitle: "<!-- annoteca/clarify: unfinished"\n---\nBody.',
			),
		).toBe(true);
		expect(out.indexOf('<!-- annoteca:store')).toBeGreaterThan(
			out.indexOf('Body.'),
		);
	});

	it('does not close off the note below an opener quoted in the properties', () => {
		const body = QUOTED_PROPS.indexOf('Body.') + 2;
		expect(insideForbidden(QUOTED_PROPS, body)).toBe(false);
		expect(planCloser(QUOTED_PROPS, body - 2, body + 2, [])).toEqual({
			kind: 'range',
			at: body + 2,
		});
	});
});
