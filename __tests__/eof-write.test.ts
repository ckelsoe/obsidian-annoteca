import { parseAll, serializeLeanMarker } from '../parser';
import {
	encodeStoreEntry,
	parseStore,
	scanStoreEntries,
	writeStoreRegion,
	type StoredComment,
} from '../store';
import { parseDocument } from '../document';

describe('serializeLeanMarker', () => {
	it('produces a category + id marker with an empty body', () => {
		expect(serializeLeanMarker('tone', 'abc12345')).toBe(
			'<!-- annoteca/tone: [id=abc12345] -->',
		);
	});

	it('parses back to a lean comment through the existing grammar', () => {
		const parsed = parseAll(serializeLeanMarker('clarify', 'deadbeef'));
		expect(parsed).toHaveLength(1);
		const c = parsed[0];
		if (!c) throw new Error('no comment');
		expect(c.category).toBe('clarify');
		expect(c.id).toBe('deadbeef');
		expect(c.body).toBe('');
		expect(c.replies).toHaveLength(0);
	});

	it('guards a category the grammar cannot match, like serialize does', () => {
		// Uppercase is not a serializable category, so it falls back rather than
		// writing a marker the parser would never find.
		const parsed = parseAll(serializeLeanMarker('NotValid', 'a1a1a1a1'));
		expect(parsed[0]?.category).toBe('uncategorized');
	});
});

describe('writeStoreRegion', () => {
	const A: StoredComment = {
		id: 'a1a1a1a1',
		category: 'note',
		body: 'a',
		replies: [],
	};
	const B: StoredComment = {
		id: 'b1b1b1b1',
		category: 'tone',
		body: 'b',
		replies: [],
	};

	it('appends a region at EOF and leaves prose + lean markers untouched', () => {
		const doc = `Prose. ${serializeLeanMarker('note', A.id)}`;
		const out = writeStoreRegion(doc, [A]);
		// The lean marker is inline, not a store block, so it is preserved verbatim.
		expect(out.startsWith(doc)).toBe(true);
		const parsed = parseStore(out);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.comment.body).toBe('a');
	});

	it('updates an existing entry in place (no second block)', () => {
		const v1 = writeStoreRegion('Prose.', [A]);
		const v2 = writeStoreRegion(v1, [{ ...A, body: 'changed' }]);
		expect(scanStoreEntries(v2)).toHaveLength(1);
		expect(parseStore(v2)[0]?.comment.body).toBe('changed');
	});

	it('removes an entry that is no longer wanted', () => {
		const both = writeStoreRegion('Prose.', [A, B]);
		const justA = writeStoreRegion(both, [A]);
		expect(parseStore(justA).map((e) => e.comment.id)).toEqual([A.id]);
	});

	it('clears the region entirely when given no entries', () => {
		const withRegion = writeStoreRegion('Prose here.', [A]);
		const cleared = writeStoreRegion(withRegion, []);
		expect(scanStoreEntries(cleared)).toHaveLength(0);
		expect(cleared).toBe('Prose here.\n');
	});

	it('is a no-op on a plain inline file with nothing to write', () => {
		const doc = 'Just prose, no store region.';
		expect(writeStoreRegion(doc, [])).toBe(doc);
	});

	it('preserves the given entry order', () => {
		const out = writeStoreRegion('Prose.', [B, A]);
		expect(parseStore(out).map((e) => e.comment.id)).toEqual([B.id, A.id]);
	});

	it('is a fixed point: writing the same entries twice equals once', () => {
		const once = writeStoreRegion('Prose.\n\nmore.', [A, B]);
		const twice = writeStoreRegion(once, [A, B]);
		expect(twice).toBe(once);
	});

	it('relocates a store block that was left mid-document to the EOF region', () => {
		const midDoc = `Top.\n${encodeStoreEntry(A)}\nBottom prose.`;
		const out = writeStoreRegion(midDoc, [A]);
		// One entry, and the region now sits after all prose.
		expect(scanStoreEntries(out)).toHaveLength(1);
		expect(out.trimEnd().endsWith('-->')).toBe(true);
		expect(out).toContain('Top.');
		expect(out).toContain('Bottom prose.');
	});
});

describe('eof write + read round trip', () => {
	it('a lean marker plus a written store region reconstructs the comment', () => {
		const stored: StoredComment = {
			id: 'c0ffee00',
			category: 'source-needed',
			body: 'needs a citation',
			replies: [
				{ author: 'ai', date: '2026-01-02', body: 'found one\nhere' },
			],
		};
		const prose = `The claim. ${serializeLeanMarker(stored.category, stored.id)}`;
		const doc = writeStoreRegion(prose, [stored]);

		const { comments, orphanedStore } = parseDocument(doc);
		expect(orphanedStore).toHaveLength(0);
		expect(comments).toHaveLength(1);
		expect(comments[0]?.body).toBe('needs a citation');
		expect(comments[0]?.replies[0]?.body).toBe('found one\nhere');
	});
});
