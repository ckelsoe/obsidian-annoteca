import {
	createApi,
	API_VERSION,
	type AnchorRange,
	type AnnotecaApi,
	type ApiComment,
	type ApiFilter,
} from '../api';
import { CommentIndex } from '../index';
import { SKILL_SCHEMA_VERSION } from '../skill-export';
import { Events } from 'obsidian';
import type AnnotecaPlugin from '../main';

// A stand-in for the plugin carrying only what the API touches: the index and
// the event bus. Building the real plugin would drag in the whole Obsidian app.
function harness(): { api: AnnotecaApi; index: CommentIndex; events: Events } {
	const index = new CommentIndex();
	const events = new Events();
	const api = createApi({
		commentIndex: index,
		events,
	} as unknown as AnnotecaPlugin);
	return { api, index, events };
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
	it('returns the documented types', () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		const filter: ApiFilter = { resolved: 'all' };
		const comments: readonly ApiComment[] = api.queryComments(filter);
		const anchors: readonly AnchorRange[] = api.anchorsFor('a.md', NOTE);
		expect(comments).toHaveLength(1);
		expect(anchors).toHaveLength(1);
	});
});

describe('AnnotecaApi: version surface', () => {
	it('reports its own version and the marker format version', () => {
		const { api } = harness();
		expect(api.apiVersion).toBe(API_VERSION);
		expect(api.apiVersion).toBe(1);
		// Mirrored so a consumer can tell which marker format this build speaks
		// without parsing a note to find out.
		expect(api.formatVersion).toBe(SKILL_SCHEMA_VERSION);
	});
});

describe('AnnotecaApi.queryComments', () => {
	it('returns open comments by default', () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		const out = api.queryComments();
		expect(out).toHaveLength(1);
		expect(out[0]?.category).toBe('tone');
		expect(out[0]?.path).toBe('a.md');
		expect(out[0]?.resolved).toBe(false);
	});

	it('filters by path and by category', () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		index.rebuild('b.md', NOTE);
		expect(api.queryComments({ paths: ['a.md'] })).toHaveLength(1);
		expect(api.queryComments({ categories: ['tone'] })).toHaveLength(2);
		expect(api.queryComments({ categories: ['cut'] })).toHaveLength(0);
	});

	// The index hands out its live objects. A consumer that mutated one would
	// corrupt the vault's view of its own comments without touching the file.
	it('returns copies, not the indexed objects', () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		const first = api.queryComments()[0];
		expect(first).toBeDefined();
		const internal = index.get('a.md')?.comments[0];
		expect(internal).toBeDefined();
		expect(first).not.toBe(internal);
		expect(first?.anchor).not.toBe(internal?.anchor);
		expect(first?.marker).not.toBe(internal?.marker);
	});

	// The public shape is narrow on purpose: anything exposed here is something
	// the API cannot change later.
	it('exposes only the documented fields', () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		expect(Object.keys(api.queryComments()[0] ?? {}).sort()).toEqual([
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

	it('is empty for an unindexed vault', () => {
		expect(harness().api.queryComments()).toEqual([]);
	});
});

describe('AnnotecaApi.anchorsFor', () => {
	it('locates the prose a comment is about, not the marker', () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		const ranges = api.anchorsFor('a.md', NOTE);
		expect(ranges).toHaveLength(1);
		const r = ranges[0];
		expect(r).toBeDefined();
		if (r) {
			expect(NOTE.slice(r.start, r.end)).toBe('the rough draft');
			expect(r.category).toBe('tone');
			expect(r.resolved).toBe(false);
			expect(r.commentId).toBe('aaaa1111');
			// The anchor sits AFTER the marker, which is the whole reason this
			// is not just the marker range.
			const marker = api.queryComments()[0]?.marker;
			expect(r.start).toBeGreaterThanOrEqual(marker?.end ?? 0);
		}
	});

	it('is empty for a path with no comments', () => {
		const { api } = harness();
		expect(api.anchorsFor('missing.md', 'text')).toEqual([]);
	});

	// Content is passed in rather than read from the vault, so an editor with
	// unsaved edits resolves against what the reader is looking at.
	it('resolves against the content it is given', () => {
		const { api, index } = harness();
		index.rebuild('a.md', NOTE);
		expect(api.anchorsFor('a.md', 'nothing matching here')).toEqual([]);
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
