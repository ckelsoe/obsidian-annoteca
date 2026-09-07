import {
	parseDocument,
	coerceStorageMode,
	resolveStorageModeForNewComment,
	convertFileToEof,
	convertFileToInline,
	isLeanMarker,
} from '../document';
import { parseAll, serialize, serializeLeanMarker } from '../parser';
import {
	encodeStoreEntry,
	parseStore,
	writeStoreRegion,
	type StoredComment,
} from '../store';

// A lean marker is a normal marker with an empty body and an id line. Built by
// hand here so the tests pin the exact on-disk shape the write path must emit.
function leanMarker(category: string, id: string): string {
	return `<!-- annoteca/${category}: [id=${id}] -->`;
}

describe('document: inline-only files are untouched', () => {
	it('returns exactly what parseAll returns when there is no store', () => {
		const doc = [
			'# Note',
			'',
			`First. ${serialize({ id: 'aaaa1111', category: 'tone', body: 'soften' })}`,
			'',
			`Second. ${serialize({ category: 'clarify', body: 'which?' })}`,
		].join('\n');

		const { comments, orphanedStore } = parseDocument(doc);
		expect(comments).toEqual(parseAll(doc));
		expect(orphanedStore).toHaveLength(0);
	});
});

describe('document: lean marker + store entry merge', () => {
	const stored: StoredComment = {
		id: 'abc12345',
		category: 'tone',
		body: 'the real body',
		date: '2026-05-23',
		author: 'charles',
		anchor: { text: 'anchored text', truncated: false },
		replies: [
			{ author: 'ai', date: '2026-05-23', body: 'multi\nline reply' },
		],
		addressed: {
			author: 'ai',
			date: '2026-05-23',
			note: 'applied',
			original: 'the verbatim original',
		},
	};

	function docWith(markerCategory: string): string {
		const lean = leanMarker(markerCategory, stored.id);
		return `Prose here. ${lean}\n\nmore prose\n\n${encodeStoreEntry(stored)}`;
	}

	it('reconstructs the full comment from the store', () => {
		const { comments, orphanedStore } = parseDocument(docWith('tone'));
		expect(orphanedStore).toHaveLength(0);
		expect(comments).toHaveLength(1);
		const c = comments[0];
		if (!c) throw new Error('no comment');
		expect(c.id).toBe('abc12345');
		expect(c.body).toBe('the real body');
		expect(c.date).toBe('2026-05-23');
		expect(c.author).toBe('charles');
		expect(c.anchor).toEqual({ text: 'anchored text', truncated: false });
		// Lossless multi-line reply — the inline marker format cannot hold this.
		expect(c.replies[0]?.body).toBe('multi\nline reply');
		expect(c.addressed?.original).toBe('the verbatim original');
	});

	it('takes category from the marker, not the store entry', () => {
		// The marker says clarify, the store still says tone; the marker wins,
		// because it is what the editor decorations and grep read at the passage.
		const { comments } = parseDocument(docWith('clarify'));
		expect(comments[0]?.category).toBe('clarify');
	});

	it('preserves the marker byte range through the merge', () => {
		const doc = docWith('tone');
		const lean = leanMarker('tone', stored.id);
		const { comments } = parseDocument(doc);
		const c = comments[0];
		if (!c) throw new Error('no comment');
		expect(doc.slice(c.marker.start, c.marker.end)).toBe(lean);
	});
});

describe('document: precedence and orphans', () => {
	it('a dangling lean marker (no store entry) comes back empty, no orphans', () => {
		const doc = `Prose. ${leanMarker('note', 'deadbeef')}`;
		const { comments, orphanedStore } = parseDocument(doc);
		expect(comments).toHaveLength(1);
		expect(comments[0]?.id).toBe('deadbeef');
		expect(comments[0]?.body).toBe('');
		expect(orphanedStore).toHaveLength(0);
	});

	it('a store entry with no marker is orphaned, not a comment', () => {
		const entry: StoredComment = {
			id: 'orphan00',
			category: 'note',
			body: 'stranded',
			replies: [],
		};
		const doc = `Just prose.\n\n${encodeStoreEntry(entry)}`;
		const { comments, orphanedStore } = parseDocument(doc);
		expect(comments).toHaveLength(0);
		expect(orphanedStore).toHaveLength(1);
		expect(orphanedStore[0]?.comment.id).toBe('orphan00');
	});

	it('an inline marker with content wins over a same-id store entry', () => {
		// The marker still carries a real body, so it is not lean; the store entry
		// must not override it, and instead becomes an orphan.
		const inline = serialize({
			id: 'shared01',
			category: 'clarify',
			body: 'inline body kept',
		});
		const entry: StoredComment = {
			id: 'shared01',
			category: 'clarify',
			body: 'store body ignored',
			replies: [],
		};
		const doc = `Prose. ${inline}\n\n${encodeStoreEntry(entry)}`;
		const { comments, orphanedStore } = parseDocument(doc);
		expect(comments[0]?.body).toBe('inline body kept');
		expect(orphanedStore).toHaveLength(1);
		expect(orphanedStore[0]?.comment.id).toBe('shared01');
	});

	it('a duplicate store id keeps the first as the merge, the second as an orphan', () => {
		const first: StoredComment = {
			id: 'dup00000',
			category: 'note',
			body: 'first',
			replies: [],
		};
		const second: StoredComment = {
			id: 'dup00000',
			category: 'note',
			body: 'second',
			replies: [],
		};
		const doc = [
			`Prose. ${leanMarker('note', 'dup00000')}`,
			'',
			encodeStoreEntry(first),
			encodeStoreEntry(second),
		].join('\n');
		const { comments, orphanedStore } = parseDocument(doc);
		expect(comments[0]?.body).toBe('first');
		expect(orphanedStore).toHaveLength(1);
		expect(orphanedStore[0]?.comment.body).toBe('second');
	});
});

describe('document: mixed inline and eof comments in one file', () => {
	it('merges the lean marker and leaves the inline one alone', () => {
		const inline = serialize({
			id: 'inline01',
			category: 'tone',
			body: 'inline comment',
		});
		const eof: StoredComment = {
			id: 'eof00001',
			category: 'clarify',
			body: 'eof comment',
			replies: [],
		};
		const doc = [
			`A. ${inline}`,
			`B. ${leanMarker('clarify', 'eof00001')}`,
			'',
			encodeStoreEntry(eof),
		].join('\n');

		const { comments, orphanedStore } = parseDocument(doc);
		expect(orphanedStore).toHaveLength(0);
		expect(comments.map((c) => c.body)).toEqual([
			'inline comment',
			'eof comment',
		]);
		expect(comments.map((c) => c.id)).toEqual(['inline01', 'eof00001']);
	});
});

describe('document: coerceStorageMode vets the frontmatter override', () => {
	it('accepts the two shipped modes', () => {
		expect(coerceStorageMode('inline')).toBe('inline');
		expect(coerceStorageMode('eof')).toBe('eof');
	});

	it('rejects the unshipped and the malformed to undefined', () => {
		// hybrid is designed but not shipped, so it is not honored yet; anything
		// non-string is a bad hand edit. Both fall back to the global default.
		expect(coerceStorageMode('hybrid')).toBeUndefined();
		expect(coerceStorageMode('EOF')).toBeUndefined();
		expect(coerceStorageMode('')).toBeUndefined();
		expect(coerceStorageMode(true)).toBeUndefined();
		expect(coerceStorageMode(undefined)).toBeUndefined();
		expect(coerceStorageMode(['eof'])).toBeUndefined();
	});
});

describe('document: resolveStorageModeForNewComment', () => {
	const inlineComment = serialize({
		id: 'inln0001',
		category: 'tone',
		body: 'inline body',
	});
	const eofEntry: StoredComment = {
		id: 'eof00001',
		category: 'clarify',
		body: 'eof body',
		replies: [],
	};
	const eofDoc = [
		`Prose. ${leanMarker('clarify', 'eof00001')}`,
		'',
		encodeStoreEntry(eofEntry),
	].join('\n');

	it("uses the note's own format over the desired mode when it has comments", () => {
		// An inline note stays inline even when the default and override both say
		// eof, and vice versa: current on-disk format wins, so a note never mixes.
		expect(
			resolveStorageModeForNewComment(
				`A. ${inlineComment}`,
				'eof',
				'eof',
			),
		).toBe('inline');
		expect(
			resolveStorageModeForNewComment(eofDoc, 'inline', 'inline'),
		).toBe('eof');
	});

	it('uses the per-note override on a note with no comments yet', () => {
		expect(
			resolveStorageModeForNewComment('Just prose.', 'eof', 'inline'),
		).toBe('eof');
		expect(
			resolveStorageModeForNewComment('Just prose.', 'inline', 'eof'),
		).toBe('inline');
	});

	it('falls back to the global default when there is no override', () => {
		expect(
			resolveStorageModeForNewComment('Just prose.', undefined, 'eof'),
		).toBe('eof');
		expect(
			resolveStorageModeForNewComment('Just prose.', undefined, 'inline'),
		).toBe('inline');
	});

	it('treats a dangling lean marker as inline, not eof', () => {
		// A lean marker with no store entry to join is a degenerate empty-bodied
		// inline marker, so the note counts as having inline comments.
		const dangling = `Prose. ${leanMarker('clarify', 'ghost000')}`;
		expect(resolveStorageModeForNewComment(dangling, 'eof', 'eof')).toBe(
			'inline',
		);
	});

	it('treats a note with only an orphaned store entry as empty', () => {
		// The marker was deleted but its entry was stranded: no live comment, so the
		// desired mode is free to apply to the next comment added.
		const orphanOnly = `Prose with no markers.\n\n${encodeStoreEntry(eofEntry)}`;
		expect(
			resolveStorageModeForNewComment(orphanOnly, undefined, 'eof'),
		).toBe('eof');
	});
});

describe('document: convertFileToEof', () => {
	it('moves an inline comment to a lean marker plus a store entry', () => {
		const inline = serialize({
			id: 'conv0001',
			category: 'clarify',
			body: 'which products?',
		});
		const { updated, converted } = convertFileToEof(`Prose. ${inline}`);
		expect(converted).toBe(1);
		// The passage now carries a lean marker (empty body), and the content is
		// in the store, reconstructed by parseDocument.
		expect(parseAll(updated)[0]?.body).toBe('');
		expect(updated).toContain('annoteca:store');
		const merged = parseDocument(updated).comments;
		expect(merged[0]?.id).toBe('conv0001');
		expect(merged[0]?.body).toBe('which products?');
	});

	it('assigns an id to an id-less inline comment', () => {
		const inline = serialize({ category: 'tone', body: 'soften this' });
		const { updated, converted } = convertFileToEof(`Prose. ${inline}`);
		expect(converted).toBe(1);
		const merged = parseDocument(updated).comments;
		expect(merged[0]?.id).toBeDefined();
		expect(merged[0]?.body).toBe('soften this');
	});

	it('leaves a note with no inline comments unchanged', () => {
		const content = writeStoreRegion(
			`Prose. <!-- annoteca/clarify: [id=already00] -->`,
			[
				{
					id: 'already00',
					category: 'clarify',
					body: 'eof',
					replies: [],
				},
			],
		);
		const { updated, converted } = convertFileToEof(content);
		expect(converted).toBe(0);
		expect(updated).toBe(content);
	});

	it('preserves existing store entries when converting a mixed note', () => {
		const inline = serialize({
			id: 'inline00',
			category: 'tone',
			body: 'inline one',
		});
		const content = writeStoreRegion(
			`A. ${inline}\n\nB. <!-- annoteca/clarify: [id=eofexist] -->`,
			[
				{
					id: 'eofexist',
					category: 'clarify',
					body: 'eof one',
					replies: [],
				},
			],
		);
		const { updated, converted } = convertFileToEof(content);
		expect(converted).toBe(1);
		const bodies = parseStore(updated)
			.map((e) => e.comment.body)
			.sort();
		expect(bodies).toEqual(['eof one', 'inline one']);
	});
});

describe('document: convertFileToInline', () => {
	const entry: StoredComment = {
		id: 'back0001',
		category: 'clarify',
		body: 'which products?',
		replies: [],
	};

	it('moves an eof comment back inline and drops the store region', () => {
		const content = writeStoreRegion(
			`Prose. <!-- annoteca/clarify: [id=back0001] -->`,
			[entry],
		);
		const { updated, converted } = convertFileToInline(content);
		expect(converted).toBe(1);
		expect(updated).not.toContain('annoteca:store');
		const c = parseAll(updated)[0];
		expect(c?.id).toBe('back0001');
		expect(c?.body).toBe('which products?');
	});

	it('keeps an orphaned store entry rather than dropping it', () => {
		const content = writeStoreRegion(
			`Prose. <!-- annoteca/clarify: [id=back0001] -->`,
			[entry, { ...entry, id: 'orphan00', body: 'stranded' }],
		);
		const { updated, converted } = convertFileToInline(content);
		expect(converted).toBe(1);
		// The joined entry inlined; the orphan stays in the store.
		const remaining = parseStore(updated);
		expect(remaining.map((e) => e.comment.id)).toEqual(['orphan00']);
	});

	it('leaves a dangling lean marker untouched', () => {
		const content = `Prose. <!-- annoteca/clarify: [id=nostore0] -->`;
		const { updated, converted } = convertFileToInline(content);
		expect(converted).toBe(0);
		expect(updated).toBe(content);
	});

	it('round-trips a simple inline comment through eof and back', () => {
		const original = `Prose. ${serialize({
			id: 'round001',
			category: 'clarify',
			body: 'a single-line body',
		})}`;
		const toEof = convertFileToEof(original).updated;
		const back = convertFileToInline(toEof).updated;
		const before = parseAll(original)[0];
		const after = parseAll(back)[0];
		expect(after?.id).toBe(before?.id);
		expect(after?.category).toBe(before?.category);
		expect(after?.body).toBe(before?.body);
		expect(back).not.toContain('annoteca:store');
	});
});

// A lean marker carries category and id only. A source line is inline content,
// so a machine-created comment with an empty body is NOT lean: classifying it as
// lean let the fold treat it as eof-backed when an entry shared its id, overwrite
// its provenance on merge, and skip it in convertFileToEof.
describe('isLeanMarker and provenance', () => {
	it('is not lean when the marker carries a source line', () => {
		const text = [
			'<!-- annoteca/prose-check: ',
			'[id=ffff6666]',
			'[source=plumbline:a1b2c3d4]',
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		expect(c?.source).toEqual({ tag: 'plumbline', key: 'a1b2c3d4' });
		expect(c && isLeanMarker(c)).toBe(false);
	});

	it('is still lean without one', () => {
		const c = parseAll(serializeLeanMarker('tone', 'abc12345'))[0];
		expect(c && isLeanMarker(c)).toBe(true);
	});
});
