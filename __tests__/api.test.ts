import {
	createApi,
	API_VERSION,
	type AnchorRange,
	type AnnotecaApi,
	type ApiCategory,
	type ApiComment,
	type ApiFilter,
} from '../api';
import type { CreatedComment, PromoteRequest } from '../types';
import type {
	AnchorRange as PubAnchorRange,
	AnnotecaApi as PubAnnotecaApi,
	ApiCategory as PubApiCategory,
	ApiComment as PubApiComment,
	ApiFilter as PubApiFilter,
	CreatedComment as PubCreatedComment,
	PromoteRequest as PubPromoteRequest,
} from '../annoteca-api';
import { CommentIndex } from '../index';
import { normalizeSettings } from '../settings';
import { parseAll, serializeLeanMarker } from '../parser';
import { writeStoreRegion, type StoredComment } from '../store';
import { Events } from 'obsidian';
import type AnnotecaPlugin from '../main';

// A stand-in for the plugin carrying only what the API touches: the index and
// the event bus. Building the real plugin would drag in the whole Obsidian app.
function harness(): {
	api: AnnotecaApi;
	index: CommentIndex;
	events: Events;
	scans: string[];
	navs: { path: string; start: number; commentId: string | undefined }[];
} {
	const index = new CommentIndex();
	const events = new Events();
	const scans: string[] = [];
	const navs: {
		path: string;
		start: number;
		commentId: string | undefined;
	}[] = [];
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
		// reveal() delegates here; the harness records the jump instead of driving
		// the real workspace, which would need the whole Obsidian app.
		navigateToComment: (
			path: string,
			start: number,
			comment?: { id: string | undefined },
		) => {
			navs.push({ path, start, commentId: comment?.id });
			return Promise.resolve();
		},
		// The real settings, because categories() resolves through the same
		// path the composer uses and a stub list would test the stub.
		settings: normalizeSettings({}),
	} as unknown as AnnotecaPlugin);
	return { api, index, events, scans, navs };
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
	it('reports its own version', () => {
		const { api } = harness();
		expect(api.apiVersion).toBe(API_VERSION);
		// 3 since reveal() landed. A consumer checking this before it wires a
		// "jump to this comment" action must be able to tell a build that has
		// reveal() from one that does not.
		expect(api.apiVersion).toBe(3);
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

describe('AnnotecaApi.reveal', () => {
	it('navigates to the comment carrying the id', async () => {
		const { api, index, navs } = harness();
		index.rebuild('a.md', NOTE);
		const ok = await api.reveal('aaaa1111');
		expect(ok).toBe(true);
		expect(navs).toHaveLength(1);
		expect(navs[0]?.path).toBe('a.md');
		expect(navs[0]?.commentId).toBe('aaaa1111');
		// The marker start, not the anchor: the marker is what the editor
		// decorations and the reviewer key on.
		const marker = index.get('a.md')?.comments[0]?.marker;
		expect(navs[0]?.start).toBe(marker?.start);
	});

	it('returns false and does not navigate for an unknown id', async () => {
		const { api, index, navs } = harness();
		index.rebuild('a.md', NOTE);
		const ok = await api.reveal('nosuchid');
		expect(ok).toBe(false);
		expect(navs).toHaveLength(0);
	});

	// Same lazy-index warm-up as queryComments, so a fresh session reveals a
	// comment in a note nobody has opened yet.
	it('warms the index before looking', async () => {
		const { api, index, scans } = harness();
		index.rebuild('a.md', NOTE);
		await api.reveal('aaaa1111');
		expect(scans).toEqual(['scanVaultIfNeeded', 'indexUnseenFiles']);
	});

	// Finds a comment in any indexed file, not just the first.
	it('locates a comment in a second file', async () => {
		const { api, index, navs } = harness();
		index.rebuild('a.md', 'Plain prose, no markers.\n');
		index.rebuild('b.md', NOTE);
		const ok = await api.reveal('aaaa1111');
		expect(ok).toBe(true);
		expect(navs[0]?.path).toBe('b.md');
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

// A consumer that creates comments has to offer a choice of category. Without
// this it would hardcode the list across a repo boundary, where it drifts the
// first time the user adds or renames one.
describe('AnnotecaApi.categories', () => {
	it('returns the ids and names a comment can be created in', () => {
		const { api } = harness();
		const cats = api.categories();
		expect(cats.length).toBeGreaterThan(0);
		for (const c of cats) {
			expect(typeof c.id).toBe('string');
			expect(typeof c.displayName).toBe('string');
		}
	});

	// The category promoted findings land in has to be offerable, or a consumer
	// cannot put a comment where the contract says it goes.
	it('includes prose-check', () => {
		expect(
			harness()
				.api.categories()
				.map((c) => c.id),
		).toContain('prose-check');
	});

	// Narrowed on purpose. Icon and colour are this plugin's rendering concern,
	// and exposing them would make them things this API can never change.
	it('exposes only the id and the display name', () => {
		const first = harness().api.categories()[0];
		expect(Object.keys(first ?? {}).sort()).toEqual(['displayName', 'id']);
	});

	it('hands back copies, not the definitions themselves', () => {
		const { api } = harness();
		const a = api.categories()[0];
		const b = api.categories()[0];
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
	});
});

// annoteca-api.d.ts is the file a consumer copies to get types. It has to stay
// byte-for-byte compatible with the runtime surface, or a consumer builds against
// a shape the plugin does not expose. This locks the two together at compile time:
// each pair must be mutually assignable, so any field, return type or method that
// drifts on one side turns a `true` below into a type error and fails the build.
type Extends<A, B> = [A] extends [B] ? true : false;
type Mutual<A, B> =
	Extends<A, B> extends true
		? Extends<B, A> extends true
			? true
			: false
		: false;

describe('annoteca-api.d.ts: the published surface matches the runtime', () => {
	it('is mutually assignable with the runtime types', () => {
		const apiLock: Mutual<AnnotecaApi, PubAnnotecaApi> = true;
		const commentLock: Mutual<ApiComment, PubApiComment> = true;
		const anchorLock: Mutual<AnchorRange, PubAnchorRange> = true;
		const categoryLock: Mutual<ApiCategory, PubApiCategory> = true;
		const filterLock: Mutual<ApiFilter, PubApiFilter> = true;
		const promoteLock: Mutual<PromoteRequest, PubPromoteRequest> = true;
		const createdLock: Mutual<CreatedComment, PubCreatedComment> = true;
		expect(
			apiLock &&
				commentLock &&
				anchorLock &&
				categoryLock &&
				filterLock &&
				promoteLock &&
				createdLock,
		).toBe(true);
	});
});
