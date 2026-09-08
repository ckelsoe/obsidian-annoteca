import {
	createApi,
	API_VERSION,
	type AnchorRange,
	type AnnotecaApi,
	type ApiComment,
	type ApiFilter,
} from '../api';
import { CommentIndex } from '../index';
import { parseAll, serializeLeanMarker } from '../parser';
import { writeStoreRegion, type StoredComment } from '../store';
import { SKILL_SCHEMA_VERSION } from '../skill-export';
import { Events } from 'obsidian';
import type AnnotecaPlugin from '../main';

// A stand-in for the plugin carrying only what the API touches: the index and
// the event bus. Building the real plugin would drag in the whole Obsidian app.
function harness(): {
	api: AnnotecaApi;
	index: CommentIndex;
	events: Events;
	scans: string[];
} {
	const index = new CommentIndex();
	const events = new Events();
	const scans: string[] = [];
	const api = createApi({
		commentIndex: index,
		events,
		// The API awaits both before querying; the harness records that it did.
		scanVaultIfNeeded: () => {
			scans.push('scanVaultIfNeeded');
			return Promise.resolve();
		},
		indexUnseenFiles: () => {
			scans.push('indexUnseenFiles');
			return Promise.resolve();
		},
	} as unknown as AnnotecaPlugin);
	return { api, index, events, scans };
}

const NOTE = [
	'Prose before it. <!-- annoteca/tone: soften this',
	'[id=aaaa1111]',
	'[anchor=the rough draft]',
	'--> the rough draft carries on here.',
	'',
].join('\n');

// The published shape, pinned at compile time. These are the types a consumer
// imports, so nothing in this repo uses them and only an explicit check keeps a
// silent narrowing from shipping.
describe('AnnotecaApi: the published shape', () => {
	it('returns the documented types', async () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		const filter: ApiFilter = { resolved: 'all' };
		const comments: readonly ApiComment[] = await api.queryComments(filter);
		const anchors: readonly AnchorRange[] = api.anchorsFor(NOTE);
		expect(comments).toHaveLength(1);
		expect(anchors).toHaveLength(1);
	});
});

describe('AnnotecaApi: version surface', () => {
	it('reports its own version and the exported-skill version', () => {
		const { api } = harness();
		expect(api.apiVersion).toBe(API_VERSION);
		// 2 since promote() landed. A consumer checking this to decide whether it
		// can promote must be able to tell a read-only build from this one.
		expect(api.apiVersion).toBe(2);
		// The exported-skill generation, not the marker format. Named for what
		// it is: SKILL_SCHEMA_VERSION bumps on teaching changes too.
		expect(api.skillSchemaVersion).toBe(SKILL_SCHEMA_VERSION);
	});
});

describe('AnnotecaApi.queryComments', () => {
	it('returns open comments by default', async () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		const out = await api.queryComments();
		expect(out).toHaveLength(1);
		expect(out[0]?.category).toBe('tone');
		expect(out[0]?.path).toBe('a.md');
		expect(out[0]?.resolved).toBe(false);
	});

	it('filters by path and by category', async () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		index.rebuild('b.md', NOTE);
		expect(await api.queryComments({ paths: ['a.md'] })).toHaveLength(1);
		expect(await api.queryComments({ categories: ['tone'] })).toHaveLength(
			2,
		);
		expect(await api.queryComments({ categories: ['cut'] })).toHaveLength(
			0,
		);
	});

	// The index hands out its live objects. A consumer that mutated one would
	// corrupt the vault's view of its own comments without touching the file.
	it('returns copies, not the indexed objects', async () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		const first = (await api.queryComments())[0];
		expect(first).toBeDefined();
		const internal = index.get('a.md')?.comments[0];
		expect(internal).toBeDefined();
		expect(first).not.toBe(internal);
		expect(first?.anchor).not.toBe(internal?.anchor);
		expect(first?.marker).not.toBe(internal?.marker);
	});

	// The public shape is narrow on purpose: anything exposed here is something
	// the API cannot change later.
	it('exposes only the documented fields', async () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		expect(
			Object.keys((await api.queryComments())[0] ?? {}).sort(),
		).toEqual([
			'addressed',
			'anchor',
			'author',
			'body',
			'category',
			'date',
			'id',
			'marker',
			'path',
			'replyCount',
			'resolved',
		]);
	});

	it('is empty for an unindexed vault', async () => {
		expect(await harness().api.queryComments()).toEqual([]);
	});
});

describe('AnnotecaApi.anchorsFor', () => {
	it('locates the prose a comment is about, not the marker', async () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		const ranges = api.anchorsFor(NOTE);
		expect(ranges).toHaveLength(1);
		const r = ranges[0];
		expect(r).toBeDefined();
		if (r) {
			expect(NOTE.slice(r.start, r.end)).toBe('the rough draft');
			expect(r.category).toBe('tone');
			expect(r.resolved).toBe(false);
			expect(r.addressed).toBe(false);
			expect(r.commentId).toBe('aaaa1111');
			// The anchor sits AFTER the marker, which is the whole reason this
			// is not just the marker range.
			const marker = (await api.queryComments())[0]?.marker;
			expect(r.start).toBeGreaterThanOrEqual(marker?.end ?? 0);
		}
	});

	it('is empty for content with no comments', () => {
		const { api } = harness();
		expect(api.anchorsFor('text with no markers')).toEqual([]);
	});

	// Content is passed in rather than read from the vault, so an editor with
	// unsaved edits resolves against what the reader is looking at.
	it('resolves against the content it is given', () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		expect(api.anchorsFor('nothing matching here')).toEqual([]);
	});

	// The defect this signature exists to avoid: an edit BEFORE the marker moves
	// every later offset. Resolving from the index would slice the old positions
	// out of the new text and lose the anchor.
	it('survives an unsaved insertion ahead of the marker', () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		const edited = 'A new opening sentence was typed here. ' + NOTE;
		const ranges = api.anchorsFor(edited);
		expect(ranges).toHaveLength(1);
		const r = ranges[0];
		expect(r && edited.slice(r.start, r.end)).toBe('the rough draft');
	});
});

// End-of-file storage (1.16.0) leaves a lean marker inline and puts the body and
// anchor in a store at the bottom of the file. Parsing only the markers loses the
// anchor, so every eof comment would vanish from this list.
describe('AnnotecaApi.anchorsFor: end-of-file storage', () => {
	it('locates prose for a comment whose anchor lives in the store', () => {
		const { api } = harness();
		// Built with the real serializers rather than hand-written, so the
		// fixture cannot drift from the format the plugin actually writes.
		const marker = serializeLeanMarker('tone', 'eeee5555');
		const stored: StoredComment = {
			id: 'eeee5555',
			category: 'tone',
			body: 'soften this',
			date: undefined,
			author: undefined,
			anchor: { text: 'the rough draft', truncated: false },
			replies: [],
			addressed: undefined,
			resolution: undefined,
			unknownLines: [],
		};
		const eof = writeStoreRegion(
			`Prose before it. ${marker} the rough draft carries on here.\n`,
			[stored],
		);

		// The fixture is only meaningful if the anchor really is in the store.
		expect(parseAll(eof)[0]?.anchor).toBeUndefined();

		const ranges = api.anchorsFor(eof);
		expect(ranges).toHaveLength(1);
		const r = ranges[0];
		expect(r && eof.slice(r.start, r.end)).toBe('the rough draft');
		expect(r?.commentId).toBe('eeee5555');
	});
});

describe('AnnotecaApi.onChange', () => {
	it('fires on an index change and stops after unsubscribing', () => {
		const { api, events } = harness();
		let calls = 0;
		const off = api.onChange(() => {
			calls += 1;
		});
		events.trigger('index-changed');
		expect(calls).toBe(1);
		off();
		events.trigger('index-changed');
		expect(calls).toBe(1);
	});
});

// `resolved` alone cannot tell an untouched comment from one with a proposed
// edit sitting in the note: both are unresolved. Interop-contract 5.1 needs them
// apart, because a prose linter yields its underline under an OPEN comment and
// not under an addressed one, whose passage is back in play.
describe('AnchorRange.addressed', () => {
	const addressedNote = [
		'Prose before it. <!-- annoteca/tone: soften this',
		'[id=bbbb2222]',
		'[anchor=the rough draft]',
		'[addressed charles 2026-09-08T10:00:00]: proposed a rewrite',
		'--> the rough draft carries on here.',
		'',
	].join('\n');

	const resolvedNote = [
		'Prose before it. <!-- annoteca/tone: soften this',
		'[id=cccc3333]',
		'[anchor=the rough draft]',
		'[resolved charles 2026-09-08T10:00:00]: done',
		'--> the rough draft carries on here.',
		'',
	].join('\n');

	it('is true for a comment awaiting accept, revise or reject', () => {
		const { api, index } = harness();
		index.rebuild('a.md', addressedNote);
		const r = api.anchorsFor(addressedNote)[0];
		expect(r?.addressed).toBe(true);
		// Still unresolved: the two flags answer different questions.
		expect(r?.resolved).toBe(false);
	});

	it('is false for a resolved comment', () => {
		const { api, index } = harness();
		index.rebuild('a.md', resolvedNote);
		const r = api.anchorsFor(resolvedNote)[0];
		expect(r?.resolved).toBe(true);
		expect(r?.addressed).toBe(false);
	});

	it('is false for an untouched comment', () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		expect(api.anchorsFor(NOTE)[0]?.addressed).toBe(false);
	});
});
