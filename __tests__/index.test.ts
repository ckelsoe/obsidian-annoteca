import { CommentIndex } from '../index';
import { serializeLeanMarker } from '../parser';
import { writeStoreRegion, type StoredComment } from '../store';

describe('CommentIndex', () => {
	const SAMPLE = `# A note

First paragraph. <!-- annoteca/tone: doesn't sound like me
[id=aaaa1111]
[date=2026-05-23]
-->

Second paragraph. <!-- annoteca/clarify: which products? -->

Third paragraph. <!-- annoteca/cut: too long
[id=bbbb2222]
[resolved charles 2026-05-25]: cut in revision
-->`;

	it('rebuilds the index for a file from its content', () => {
		const idx = new CommentIndex();
		idx.rebuild('note.md', SAMPLE);
		const file = idx.get('note.md');
		expect(file?.comments).toHaveLength(3);
	});

	it('queries unresolved comments by default', () => {
		const idx = new CommentIndex();
		idx.rebuild('note.md', SAMPLE);
		const unresolved = idx.queryUnresolved();
		expect(unresolved).toHaveLength(2);
		const categories = unresolved.map((c) => c.comment.category).sort();
		expect(categories).toEqual(['clarify', 'tone']);
	});

	it('filters by category and resolved state', () => {
		const idx = new CommentIndex();
		idx.rebuild('note.md', SAMPLE);
		const cuts = idx.queryUnresolved({
			categories: new Set(['cut']),
			resolved: 'all',
		});
		expect(cuts).toHaveLength(1);
	});

	it('detects ID collisions across files', () => {
		const idx = new CommentIndex();
		idx.rebuild(
			'a.md',
			`<!-- annoteca/tone: body
[id=aaaa1111]
-->`,
		);
		idx.rebuild(
			'b.md',
			`<!-- annoteca/cut: body
[id=bbbb2222]
-->`,
		);
		expect(idx.hasId('aaaa1111')).toBe(true);
		expect(idx.hasId('bbbb2222')).toBe(true);
		expect(idx.hasId('zzzzzzzz')).toBe(false);
	});

	it('renames file entries', () => {
		const idx = new CommentIndex();
		idx.rebuild('old.md', SAMPLE);
		idx.rename('old.md', 'new.md');
		expect(idx.get('old.md')).toBeUndefined();
		expect(idx.get('new.md')?.comments).toHaveLength(3);
	});

	it('drops file entries on remove', () => {
		const idx = new CommentIndex();
		idx.rebuild('note.md', SAMPLE);
		idx.remove('note.md');
		expect(idx.get('note.md')).toBeUndefined();
	});

	it('reports stats', () => {
		const idx = new CommentIndex();
		idx.rebuild('note.md', SAMPLE);
		const s = idx.stats();
		expect(s.fileCount).toBe(1);
		expect(s.commentCount).toBe(3);
		expect(s.unresolvedCount).toBe(2);
	});
});

// The index is where the marker diagnostic finally gets asked. Its only caller
// used to be a command, so a user with no reason to suspect a problem never ran
// it, and the damage cost them a paragraph before anything mentioned it.
describe('CommentIndex carries marker damage', () => {
	it('reports an unclosed opener alongside the comments it did find', () => {
		const idx = new CommentIndex();
		const built = idx.rebuild(
			'note.md',
			[
				'<!-- annoteca/todo: never closed',
				'[id=aaaaaaaa]',
				'',
				'Prose.',
				'',
				'<!-- annoteca/question: second',
				'[id=bbbbbbbb]',
				'-->',
			].join('\n'),
		);
		expect(built.comments.map((c) => c.id)).toEqual(['bbbbbbbb']);
		expect(built.malformed.map((m) => m.kind)).toEqual(['unclosed-opener']);
	});

	it('is empty for a healthy file', () => {
		const idx = new CommentIndex();
		const built = idx.rebuild('note.md', '<!-- annoteca/tone: fine -->');
		expect(built.malformed).toEqual([]);
	});
});

// The index rebuilds through parseDocument, so an eof-mode comment (a lean
// category+id marker in the prose, its body/thread/resolution in the end-of-file
// store) is merged before anything reads it. Without this, every read surface
// that reads the index (the Hub, the counts, the frontmatter summary) would see
// the lean marker as an empty, open comment. Issue #48, Unit 2.
describe('CommentIndex reads eof-mode storage', () => {
	const OPEN_ENTRY: StoredComment = {
		id: 'open1111',
		category: 'clarify',
		body: 'which products?',
		replies: [],
	};
	const RESOLVED_ENTRY: StoredComment = {
		id: 'done2222',
		category: 'cut',
		body: 'too long, tighten it',
		replies: [],
		resolution: {
			author: 'charles',
			date: '2026-05-25',
			note: 'cut in revision',
		},
	};
	// One open and one resolved eof comment: two lean markers in the prose, both
	// bodies and the resolution in the EOF store.
	const EOF_DOC = writeStoreRegion(
		`# Note\n\nOne. ${serializeLeanMarker(
			'clarify',
			'open1111',
		)}\n\nTwo. ${serializeLeanMarker('cut', 'done2222')}\n`,
		[OPEN_ENTRY, RESOLVED_ENTRY],
	);

	it('merges each lean marker with its store entry', () => {
		const idx = new CommentIndex();
		const built = idx.rebuild('note.md', EOF_DOC);
		const byId = new Map(built.comments.map((c) => [c.id, c]));
		expect(byId.get('open1111')?.body).toBe('which products?');
		expect(byId.get('done2222')?.body).toBe('too long, tighten it');
		expect(byId.get('done2222')?.resolution?.note).toBe('cut in revision');
	});

	it('counts an eof resolution from the store, not the lean marker', () => {
		const idx = new CommentIndex();
		idx.rebuild('note.md', EOF_DOC);
		// The bug this guards: reading the lean marker alone, a resolved eof
		// comment looks open, so annoteca_open would stay at 1 after it resolves.
		expect(idx.stats()).toMatchObject({
			commentCount: 2,
			unresolvedCount: 1,
		});
		const open = idx.queryUnresolved();
		expect(open.map((c) => c.comment.id)).toEqual(['open1111']);
	});

	it('leaves a dangling lean marker untouched (no store entry to join)', () => {
		// A lean marker whose id joins no store entry is not eof-mode; it falls
		// through as the empty, open comment parseAll would have produced, so the
		// merge never invents content for a marker the store does not back.
		const idx = new CommentIndex();
		const built = idx.rebuild(
			'note.md',
			`Prose. ${serializeLeanMarker('clarify', 'ghost000')}\n`,
		);
		expect(built.comments).toHaveLength(1);
		expect(built.comments[0]?.body).toBe('');
		expect(built.comments[0]?.resolution).toBeUndefined();
	});

	it('parses an inline-only file identically (no store region)', () => {
		const idx = new CommentIndex();
		const built = idx.rebuild(
			'note.md',
			'Prose. <!-- annoteca/tone: sounds off\n[id=inline00]\n-->',
		);
		expect(built.comments).toHaveLength(1);
		expect(built.comments[0]?.body).toBe('sounds off');
	});
});
