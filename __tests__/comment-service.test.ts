import { MarkdownView, TFile } from 'obsidian';

// Relative, so it types against __mocks__/obsidian.ts rather than obsidian.d.ts.
import { noticeLog } from '../__mocks__/obsidian';
import type AnnotecaPlugin from '../main';
import { CommentService } from '../comment-service';
import { parseAll } from '../parser';

beforeEach(() => {
	noticeLog.length = 0;
});

const NOTE = [
	'Prose under review. <!-- annoteca/clarify: which products?',
	'[id=a1b2c3d4]',
	'-->',
	'',
	'More prose.',
].join('\n');

// Stub plugin exercising the closed-file write path (no markdown leaves →
// vault.modify). The editor path shares applySplices and is validated by hand.
function makeHarness(deleteOnResolve: boolean) {
	let content = NOTE;
	const file = new TFile();
	const plugin = {
		settings: {
			enableAuthorTag: true,
			authorTag: 'charles',
			deleteOnResolve,
		},
		app: {
			vault: {
				getAbstractFileByPath: () => file,
				read: () => Promise.resolve(content),
				// The service writes through vault.process, which reads and
				// writes under one lock. Modelled here as read-transform-store
				// so a stale-offset write cannot slip past the comparison.
				process: (_file: TFile, fn: (data: string) => string) => {
					content = fn(content);
					return Promise.resolve(content);
				},
			},
			workspace: {
				getLeavesOfType: () => [],
				getActiveFile: () => null,
			},
		},
		commentIndex: { rebuild: () => undefined },
		events: { trigger: () => undefined },
	} as unknown as AnnotecaPlugin;
	return {
		service: new CommentService(plugin),
		get content() {
			return content;
		},
	};
}

// Variant harness seeded with an arbitrary document, for the addressed-state
// transitions (F-270). Same closed-file (vault.modify) write path as makeHarness.
function makeHarnessWith(initial: string, deleteOnResolve = false) {
	let content = initial;
	const file = new TFile();
	const plugin = {
		settings: {
			enableAuthorTag: true,
			authorTag: 'charles',
			deleteOnResolve,
		},
		app: {
			vault: {
				// Path-aware on purpose. A harness that hands back the same file
				// whatever it is asked for cannot tell "wrote to the file it was
				// given" from "wrote to whatever was focused", which is exactly
				// the bug the appendReply path tests are about.
				getAbstractFileByPath: (p: string) =>
					p === 'note.md' ? file : null,
				read: () => Promise.resolve(content),
				// The service writes through vault.process, which reads and
				// writes under one lock. Modelled here as read-transform-store
				// so a stale-offset write cannot slip past the comparison.
				process: (_file: TFile, fn: (data: string) => string) => {
					content = fn(content);
					return Promise.resolve(content);
				},
			},
			workspace: {
				getLeavesOfType: () => [],
				// Deliberately NOT the file under test, standing in for a Hub
				// card in a folder scope whose note is not the active one.
				getActiveFile: () => ({ path: 'some/other-note.md' }),
			},
		},
		commentIndex: { rebuild: () => undefined },
		events: { trigger: () => undefined },
	} as unknown as AnnotecaPlugin;
	return {
		service: new CommentService(plugin),
		get content() {
			return content;
		},
		// Simulates the file changing underneath a rendered Hub card: an
		// assistant replying, another pane writing, a sync landing. Used by the
		// stale-snapshot tests (#12).
		set content(updated: string) {
			content = updated;
		},
	};
}

function firstComment(content: string) {
	const comments = parseAll(content);
	expect(comments).toHaveLength(1);
	const c = comments[0];
	if (!c) throw new Error('no comment parsed');
	return c;
}

describe('resolveComment with delete-on-resolve off', () => {
	it('keeps the marker and appends a [resolved ...] line', async () => {
		const h = makeHarness(false);
		await h.service.resolveComment('note.md', firstComment(h.content));
		const after = parseAll(h.content);
		expect(after).toHaveLength(1);
		expect(after[0]?.resolution?.author).toBe('charles');
		expect(h.content).toContain('annoteca/clarify');
	});

	it('is a no-op on an already-resolved comment', async () => {
		const h = makeHarness(false);
		await h.service.resolveComment('note.md', firstComment(h.content));
		const before = h.content;
		await h.service.resolveComment('note.md', firstComment(h.content));
		expect(h.content).toBe(before);
	});
});

describe('resolveComment with delete-on-resolve on', () => {
	it('removes the marker entirely', async () => {
		const h = makeHarness(true);
		await h.service.resolveComment('note.md', firstComment(h.content));
		expect(parseAll(h.content)).toHaveLength(0);
		expect(h.content).not.toContain('annoteca');
		// The prose itself survives.
		expect(h.content).toContain('Prose under review.');
		expect(h.content).toContain('More prose.');
	});
});

describe('resolveAndRemoveComment', () => {
	it('removes the marker regardless of the toggle', async () => {
		const h = makeHarness(false);
		await h.service.resolveAndRemoveComment(
			'note.md',
			firstComment(h.content),
		);
		expect(parseAll(h.content)).toHaveLength(0);
		expect(h.content).toContain('Prose under review.');
	});
});

describe('deleteComment', () => {
	it('removes the marker from the document body (same as resolve-and-remove)', async () => {
		const h = makeHarness(false);
		await h.service.deleteComment('note.md', firstComment(h.content));
		expect(parseAll(h.content)).toHaveLength(0);
		expect(h.content).not.toContain('annoteca');
		// The surrounding prose survives.
		expect(h.content).toContain('Prose under review.');
		expect(h.content).toContain('More prose.');
	});

	it('removes the marker by id even when the cached offsets are stale', async () => {
		// The Thread panel can hold a comment whose marker offsets no longer
		// match the document (edited since the last index build). Splicing on
		// those stale offsets used to remove the wrong range and leave the
		// marker; re-resolving by id fixes it.
		const h = makeHarness(false);
		const c = firstComment(h.content);
		const stale = { ...c, marker: { start: 0, end: 3 } };
		await h.service.deleteComment('note.md', stale);
		expect(parseAll(h.content)).toHaveLength(0);
		expect(h.content).not.toContain('annoteca');
		expect(h.content).toContain('Prose under review.');
	});
});

describe('addressed-state transitions (F-270/F-271/F-272)', () => {
	// Begin-placed marker leading the replaced prose, with an annoteca-original
	// fence holding the verbatim old text.
	const ADDRESSED_MARKER = [
		'<!-- annoteca/clarify: tighten this',
		'[id=addr0001]',
		'[date=2026-06-20]',
		'[anchor=the old sentence]',
		'[addressed claude 2026-06-20]: replaced the sentence',
		'```annoteca-original',
		'The old sentence.',
		'```',
		'-->',
	].join('\n');
	const ADDRESSED_DOC = `${ADDRESSED_MARKER} The new sentence.\n\nMore prose.`;

	const OPEN_DOC = [
		'<!-- annoteca/clarify: tighten this',
		'[id=addr0001]',
		'-->',
		'',
		'Body.',
	].join('\n');

	it('applyAddressed writes an [addressed ...] line with the original fence', async () => {
		const h = makeHarnessWith(OPEN_DOC);
		await h.service.applyAddressed(
			'note.md',
			firstComment(h.content),
			'did the edit',
			'the old text',
		);
		const c = firstComment(h.content);
		expect(c.addressed?.author).toBe('charles');
		expect(c.addressed?.note).toBe('did the edit');
		expect(c.addressed?.original).toBe('the old text');
		expect(h.content).toContain('```annoteca-original');
	});

	it('acceptAddressed resolves and drops the addressed line (delete-on-resolve off)', async () => {
		const h = makeHarnessWith(ADDRESSED_DOC);
		await h.service.acceptAddressed('note.md', firstComment(h.content));
		const c = firstComment(h.content);
		expect(c.addressed).toBeUndefined();
		expect(c.resolution?.author).toBe('charles');
		expect(c.resolution?.note).toBe('accepted');
		// The applied (new) prose is kept.
		expect(h.content).toContain('The new sentence.');
		expect(h.content).not.toContain('annoteca-original');
	});

	it('acceptAddressed removes the marker when delete-on-resolve is on', async () => {
		const h = makeHarnessWith(ADDRESSED_DOC, true);
		await h.service.acceptAddressed('note.md', firstComment(h.content));
		expect(parseAll(h.content)).toHaveLength(0);
		// The accepted prose survives.
		expect(h.content).toContain('The new sentence.');
	});

	it('reviseAddressed drops the addressed line and returns the comment to open', async () => {
		const h = makeHarnessWith(ADDRESSED_DOC);
		await h.service.reviseAddressed('note.md', firstComment(h.content));
		const c = firstComment(h.content);
		expect(c.addressed).toBeUndefined();
		expect(c.resolution).toBeUndefined();
		// Revise keeps the applied prose for the reviewer to edit.
		expect(h.content).toContain('The new sentence.');
		expect(h.content).not.toContain('annoteca-original');
	});

	it('rejectAddressed restores the original text byte-for-byte and reopens', async () => {
		const h = makeHarnessWith(ADDRESSED_DOC);
		await h.service.rejectAddressed('note.md', firstComment(h.content));
		const expectedMarker = [
			'<!-- annoteca/clarify: tighten this',
			'[id=addr0001]',
			'[date=2026-06-20]',
			'[anchor=the old sentence]',
			'-->',
		].join('\n');
		expect(h.content).toBe(
			`${expectedMarker} The old sentence.\n\nMore prose.`,
		);
		const c = firstComment(h.content);
		expect(c.addressed).toBeUndefined();
		expect(c.resolution).toBeUndefined();
	});

	it('rejectAddressed with no stored original degrades to revise (drops addressed)', async () => {
		const noFence = [
			'<!-- annoteca/clarify: tighten this',
			'[id=addr0002]',
			'[addressed claude 2026-06-20]: tweaked in place',
			'--> the prose.',
		].join('\n');
		const h = makeHarnessWith(noFence);
		await h.service.rejectAddressed('note.md', firstComment(h.content));
		const c = firstComment(h.content);
		expect(c.addressed).toBeUndefined();
		// Nothing to revert: the prose is left untouched.
		expect(h.content).toContain('the prose.');
	});
});

// Issue #12. Every panel action used to serialize the Comment captured when the
// card was rendered, so anything that landed in the marker between render and
// button press was silently overwritten. Each test takes a snapshot, changes the
// file underneath it, then acts on the snapshot.
const IDLESS = [
	'<!-- annoteca/clarify: which products?',
	'[reply bob 2026-06-20]: the first one',
	'-->',
].join('\n');

const THREADED_ID = [
	'Prose before. <!-- annoteca/clarify: which products?',
	'[id=stale009]',
	'-->',
	'',
	'Prose after.',
].join('\n');

describe('#12: actions build from current file state, not a cached snapshot', () => {
	const THREADED = [
		'<!-- annoteca/clarify: which products?',
		'[id=stale001]',
		'[reply bob 2026-06-20]: the first one',
		'-->',
	].join('\n');

	// The reply that arrives after the card was drawn.
	const withSecondReply = (doc: string): string =>
		doc.replace(
			'[reply bob 2026-06-20]: the first one',
			'[reply bob 2026-06-20]: the first one\n[reply claude 2026-06-21]: landed later',
		);

	it('appendReply keeps a reply that landed after the snapshot', async () => {
		const h = makeHarnessWith(THREADED);
		const snapshot = firstComment(h.content);
		h.content = withSecondReply(h.content);

		const wrote = await h.service.appendReply('note.md', snapshot, {
			author: 'charles',
			date: '2026-06-22',
			body: 'and mine',
		});

		expect(wrote).toBe(true);
		const bodies = firstComment(h.content).replies.map((r) => r.body);
		expect(bodies).toEqual(['the first one', 'landed later', 'and mine']);
	});

	it('resolveComment keeps a reply that landed after the snapshot', async () => {
		const h = makeHarnessWith(THREADED);
		const snapshot = firstComment(h.content);
		h.content = withSecondReply(h.content);

		await h.service.resolveComment('note.md', snapshot);

		const c = firstComment(h.content);
		expect(c.resolution?.author).toBe('charles');
		expect(c.replies.map((r) => r.body)).toEqual([
			'the first one',
			'landed later',
		]);
	});

	it('resolveComment refuses to overwrite a resolution written in the meantime', async () => {
		const h = makeHarnessWith(THREADED);
		const snapshot = firstComment(h.content);
		h.content = h.content.replace(
			'-->',
			'[resolved someone-else 2026-06-21]: handled\n-->',
		);

		await h.service.resolveComment('note.md', snapshot);

		const c = firstComment(h.content);
		expect(c.resolution?.author).toBe('someone-else');
		expect(c.resolution?.note).toBe('handled');
	});

	it('acceptAddressed keeps a reply that landed after the snapshot', async () => {
		const doc = [
			'<!-- annoteca/clarify: tighten this',
			'[id=stale002]',
			'[reply bob 2026-06-20]: the first one',
			'[addressed claude 2026-06-20]: cut the framing',
			'--> The new sentence.',
		].join('\n');
		const h = makeHarnessWith(doc);
		const snapshot = firstComment(h.content);
		h.content = withSecondReply(h.content);

		await h.service.acceptAddressed('note.md', snapshot);

		const c = firstComment(h.content);
		expect(c.resolution?.note).toBe('accepted');
		expect(c.replies.map((r) => r.body)).toEqual([
			'the first one',
			'landed later',
		]);
	});

	it('rejectAddressed keeps a reply that landed after the snapshot', async () => {
		const doc = [
			'<!-- annoteca/clarify: tighten this',
			'[id=stale003]',
			'[reply bob 2026-06-20]: the first one',
			'[addressed claude 2026-06-20]: cut the framing',
			'```annoteca-original',
			'The old sentence.',
			'```',
			'--> The new sentence.',
		].join('\n');
		const h = makeHarnessWith(doc);
		const snapshot = firstComment(h.content);
		h.content = withSecondReply(h.content);

		await h.service.rejectAddressed('note.md', snapshot);

		const c = firstComment(h.content);
		expect(c.addressed).toBeUndefined();
		expect(c.replies.map((r) => r.body)).toEqual([
			'the first one',
			'landed later',
		]);
		expect(h.content).toContain('The old sentence.');
	});

	it('rejectAddressed refuses once the edit is no longer awaiting review', async () => {
		const doc = [
			'<!-- annoteca/clarify: tighten this',
			'[id=stale004]',
			'[addressed claude 2026-06-20]: cut the framing',
			'```annoteca-original',
			'The old sentence.',
			'```',
			'--> The new sentence.',
		].join('\n');
		const h = makeHarnessWith(doc);
		const snapshot = firstComment(h.content);
		// Someone accepts it while the card sits on screen.
		await h.service.acceptAddressed('note.md', firstComment(h.content));
		const afterAccept = h.content;

		await h.service.rejectAddressed('note.md', snapshot);

		// The prose is NOT reverted: reverting would overwrite text the user has
		// already moved on from.
		expect(h.content).toBe(afterAccept);
		expect(h.content).toContain('The new sentence.');
	});

	// Id-less markers are a supported part of the format, so they resolve by
	// fingerprint (same range, same category, same body) rather than being
	// refused outright, which would break them permanently.
	it('resolves an id-less marker by fingerprint when it still matches', async () => {
		const h = makeHarnessWith(IDLESS);
		await h.service.resolveComment('note.md', firstComment(h.content));

		const c = firstComment(h.content);
		expect(c.resolution?.author).toBe('charles');
		expect(c.replies.map((r) => r.body)).toEqual(['the first one']);
	});

	it('refuses an id-less marker whose body changed underneath', async () => {
		const h = makeHarnessWith(IDLESS);
		const snapshot = firstComment(h.content);
		h.content = h.content.replace('which products?', 'rewritten elsewhere');
		const before = h.content;

		await h.service.resolveComment('note.md', snapshot);

		expect(h.content).toBe(before);
		expect(firstComment(h.content).resolution).toBeUndefined();
	});
});

// The marker a panel card points at can be gone by the time the button is
// pressed. Falling back to the cached offsets then writes into whatever prose
// now occupies that range: resolve overwrites it with a marker, delete removes
// it outright. A failed lookup means "gone", and gone has to abort.
describe('#12: a vanished marker aborts instead of writing at stale offsets', () => {
	// The snapshot's offsets stay valid-looking while pointing at prose that has
	// nothing to do with it.
	const withMarkerRemoved = (doc: string): string =>
		doc.replace(
			/<!-- annoteca[\s\S]*?-->/,
			'Replacement prose exactly here.',
		);

	it('resolveComment does not touch the file', async () => {
		const h = makeHarnessWith(THREADED_ID);
		const snapshot = firstComment(h.content);
		h.content = withMarkerRemoved(h.content);
		const before = h.content;

		await h.service.resolveComment('note.md', snapshot);

		expect(h.content).toBe(before);
		expect(h.content).toContain('Replacement prose exactly here.');
	});

	it('deleteComment does not remove the prose that took its place', async () => {
		const h = makeHarnessWith(THREADED_ID);
		const snapshot = firstComment(h.content);
		h.content = withMarkerRemoved(h.content);
		const before = h.content;

		await h.service.deleteComment('note.md', snapshot);

		expect(h.content).toBe(before);
		expect(h.content).toContain('Replacement prose exactly here.');
	});

	it('resolveAndRemoveComment does not remove it either', async () => {
		const h = makeHarnessWith(THREADED_ID);
		const snapshot = firstComment(h.content);
		h.content = withMarkerRemoved(h.content);
		const before = h.content;

		await h.service.resolveAndRemoveComment('note.md', snapshot);

		expect(h.content).toBe(before);
	});

	it('appendReply does not write the reply into unrelated prose', async () => {
		const h = makeHarnessWith(THREADED_ID);
		const snapshot = firstComment(h.content);
		h.content = withMarkerRemoved(h.content);
		const before = h.content;

		const wrote = await h.service.appendReply('note.md', snapshot, {
			author: 'charles',
			date: '2026-06-22',
			body: 'and mine',
		});

		// The return value is what stops the composer clearing the user's text
		// and the popup announcing "Reply added." when nothing was written.
		expect(wrote).toBe(false);
		expect(h.content).toBe(before);
		expect(h.content).not.toContain('and mine');
	});
});

// The deleteOnResolve shortcut was the one lifecycle path that re-resolved the
// marker's OFFSETS without re-checking the STATE the action was aimed at, and it
// is the destructive one: it removes the marker, its body, and its whole thread.
describe('#12: the destructive deleteOnResolve branch checks current state too', () => {
	const ADDRESSED = [
		'Prose. <!-- annoteca/clarify: tighten this',
		'[id=delres01]',
		'[reply bob 2026-06-20]: a reply worth keeping',
		'[addressed claude 2026-06-20]: cut the framing',
		'--> The new sentence.',
	].join('\n');

	it('acceptAddressed refuses when the edit is no longer awaiting review', async () => {
		const h = makeHarnessWith(ADDRESSED, true);
		const snapshot = firstComment(h.content);
		// Someone revises it while the card sits on screen.
		await h.service.reviseAddressed('note.md', firstComment(h.content));
		const afterRevise = h.content;

		await h.service.acceptAddressed('note.md', snapshot);

		// The marker, its body, and the reply all survive.
		expect(h.content).toBe(afterRevise);
		expect(parseAll(h.content)).toHaveLength(1);
		expect(firstComment(h.content).replies.map((r) => r.body)).toEqual([
			'a reply worth keeping',
		]);
	});

	it('resolveComment refuses when a resolution landed in the meantime', async () => {
		const doc = [
			'Prose. <!-- annoteca/clarify: which products?',
			'[id=delres02]',
			'-->',
		].join('\n');
		const h = makeHarnessWith(doc, true);
		const snapshot = firstComment(h.content);
		h.content = h.content.replace(
			'-->',
			'[resolved someone-else 2026-06-21]: handled\n-->',
		);
		const before = h.content;

		await h.service.resolveComment('note.md', snapshot);

		expect(h.content).toBe(before);
		expect(firstComment(h.content).resolution?.author).toBe('someone-else');
	});

	// The explicit action passes no guard, so it still removes whatever is there.
	it('the explicit resolve-and-remove is unguarded and still removes', async () => {
		const h = makeHarnessWith(ADDRESSED, true);
		await h.service.resolveAndRemoveComment(
			'note.md',
			firstComment(h.content),
		);
		expect(parseAll(h.content)).toHaveLength(0);
		expect(h.content).toContain('The new sentence.');
	});
});

// A Hub card in a folder or vault scope belongs to a note that is not
// necessarily the active one. appendReply used to resolve the target from
// workspace.getActiveFile(), so replying from such a card aimed the write at
// whatever happened to be focused.
describe('#12: appendReply writes to the file it was given', () => {
	const DOC = [
		'Prose. <!-- annoteca/clarify: which products?',
		'[id=pathchk1]',
		'-->',
	].join('\n');

	it('uses the caller path, not the active file', async () => {
		const h = makeHarnessWith(DOC);
		// The harness reports some/other-note.md as active and only resolves
		// note.md, so a write aimed at the active file finds nothing.
		const wrote = await h.service.appendReply(
			'note.md',
			firstComment(h.content),
			{ author: 'charles', date: '2026-06-22', body: 'from the panel' },
		);
		expect(wrote).toBe(true);
		expect(firstComment(h.content).replies.map((r) => r.body)).toEqual([
			'from the panel',
		]);
	});

	it('refuses an empty path rather than guessing', async () => {
		const h = makeHarnessWith(DOC);
		const wrote = await h.service.appendReply('', firstComment(h.content), {
			author: 'charles',
			date: '2026-06-22',
			body: 'nowhere',
		});
		expect(wrote).toBe(false);
		expect(firstComment(h.content).replies).toHaveLength(0);
	});
});

// A Hub card can outlive its note: folder and vault scopes render cards for
// files the user is not looking at, and one can be renamed or deleted between
// the render and the button press. Every write path used to return silently.
describe('#12: a write aimed at a missing file reports instead of no-oping', () => {
	function makeHarnessWithNoFile() {
		const plugin = {
			settings: {
				enableAuthorTag: true,
				authorTag: 'charles',
				deleteOnResolve: false,
			},
			app: {
				vault: {
					getAbstractFileByPath: () => null,
					read: () => Promise.resolve(''),
					modify: () => Promise.resolve(),
				},
				workspace: {
					getLeavesOfType: () => [],
					getActiveFile: () => ({ path: 'gone.md' }),
				},
			},
			commentIndex: { rebuild: () => undefined },
			events: { trigger: () => undefined },
		} as unknown as AnnotecaPlugin;
		return new CommentService(plugin);
	}

	const snapshot = firstComment(
		'<!-- annoteca/clarify: which products?\n[id=gonefile]\n-->',
	);

	// The Notice text itself is not asserted here. jest.spyOn cannot call through
	// to an ES class constructor ("cannot be invoked without 'new'"), and the
	// ways around that are a type assertion on the mock or a recording member on
	// the Obsidian stub that the real obsidian.d.ts does not have, which would
	// compile under Jest and fail `npm run build`. What IS asserted is the
	// contract the caller depends on, which is the part that can silently rot.
	it('appendReply refuses rather than reporting a write it did not do', async () => {
		const service = makeHarnessWithNoFile();
		const wrote = await service.appendReply('gone.md', snapshot, {
			author: 'charles',
			date: '2026-06-22',
			body: 'into the void',
		});
		expect(wrote).toBe(false);
	});

	// The confirmation modal sits between the resolved-count check and the write,
	// so the note can go away in between. Returning 0 made the caller announce
	// "Deleted 0 resolved comments", which reads as "there were none".
	it('deleteAllResolvedInFile returns null rather than a misleading 0', async () => {
		const service = makeHarnessWithNoFile();
		await expect(
			service.deleteAllResolvedInFile('gone.md'),
		).resolves.toBeNull();
	});

	it('deleteAllResolvedInFile still returns a count when the file is there', async () => {
		const h = makeHarnessWith(
			[
				'<!-- annoteca/clarify: done with this',
				'[id=bulk0001]',
				'[resolved charles 2026-06-20]: handled',
				'-->',
			].join('\n'),
		);
		await expect(
			h.service.deleteAllResolvedInFile('note.md'),
		).resolves.toBe(1);
	});

	it('resolveComment does not throw when the file is gone', async () => {
		const service = makeHarnessWithNoFile();
		await expect(
			service.resolveComment('gone.md', snapshot),
		).resolves.toBeUndefined();
	});

	it('deleteComment does not throw when the file is gone', async () => {
		const service = makeHarnessWithNoFile();
		await expect(
			service.deleteComment('gone.md', snapshot),
		).resolves.toBeUndefined();
	});
});

describe('applyAddressed refuses to overwrite a concurrent addressed state', () => {
	const OPEN = [
		'<!-- annoteca/clarify: tighten this',
		'[id=conc0001]',
		'-->',
		'',
		'Body.',
	].join('\n');

	// The addressed note that lands after the caller took its snapshot: an
	// assistant applying an edit, another pane, or a sync.
	const addressedByOther = [
		'<!-- annoteca/clarify: tighten this',
		'[id=conc0001]',
		'[addressed claude 2026-06-20]: they replaced it first',
		'```annoteca-original',
		'the FIRST original',
		'```',
		'-->',
		'',
		'Body.',
	].join('\n');

	it('keeps the original the other writer stored, instead of replacing it', async () => {
		const h = makeHarnessWith(OPEN);
		const snapshot = firstComment(h.content);
		h.content = addressedByOther;

		await h.service.applyAddressed(
			'note.md',
			snapshot,
			'mine',
			'the SECOND original',
		);

		const c = firstComment(h.content);
		// The original is the only revert source rejectAddressed has, so
		// clobbering it loses the earlier prose permanently.
		expect(c.addressed?.author).toBe('claude');
		expect(c.addressed?.note).toBe('they replaced it first');
		expect(c.addressed?.original).toBe('the FIRST original');
		expect(h.content).not.toContain('the SECOND original');
	});

	it('says so rather than failing silently', async () => {
		const h = makeHarnessWith(OPEN);
		const snapshot = firstComment(h.content);
		h.content = addressedByOther;

		await h.service.applyAddressed('note.md', snapshot, 'mine', 'x');

		expect(noticeLog).toContain('This comment is already awaiting review.');
		expect(noticeLog).not.toContain('Marked as addressed.');
	});

	it('still writes when nothing addressed it first', async () => {
		const h = makeHarnessWith(OPEN);
		await h.service.applyAddressed(
			'note.md',
			firstComment(h.content),
			'mine',
			'the old text',
		);

		expect(firstComment(h.content).addressed?.note).toBe('mine');
		expect(noticeLog).toContain('Marked as addressed.');
	});
});

describe('a duplicated marker id refuses instead of writing to the wrong one', () => {
	// Copy-pasting a marker inside a note is the ordinary way this happens; ids
	// live in file text, so nothing stops two markers carrying one id.
	const TWINS = [
		'<!-- annoteca/clarify: the first one',
		'[id=twin0001]',
		'-->',
		'',
		'Prose.',
		'',
		'<!-- annoteca/clarify: the second one',
		'[id=twin0001]',
		'-->',
	].join('\n');

	const secondOf = (content: string) => {
		const all = parseAll(content);
		expect(all).toHaveLength(2);
		const c = all[1];
		if (!c) throw new Error('no second comment parsed');
		return c;
	};

	it('does not resolve the first twin when the card points at the second', async () => {
		const h = makeHarnessWith(TWINS);
		await h.service.resolveComment('note.md', secondOf(h.content));

		// Neither is resolved: the lookup is ambiguous, so it declines.
		expect(
			parseAll(h.content).every((c) => c.resolution === undefined),
		).toBe(true);
	});

	it('names the duplicated identifier instead of claiming the comment vanished', () => {
		// "Moved or deleted, reopen the note" is false here and reopening
		// cannot fix it, so it would leave every action dead with no way to
		// understand why. The message has to say what is actually wrong.
		const h = makeHarnessWith(TWINS);
		return h.service
			.resolveComment('note.md', secondOf(h.content))
			.then(() => {
				expect(noticeLog).toHaveLength(1);
				expect(noticeLog[0]).toContain('twin0001');
				expect(noticeLog[0]).toContain('More than one comment');
				expect(noticeLog[0]).not.toContain('moved or been deleted');
			});
	});

	it('still says "vanished" when the marker really is gone', () => {
		const h = makeHarnessWith(TWINS);
		const snapshot = secondOf(h.content);
		h.content = 'Prose with no markers at all.';

		return h.service.resolveComment('note.md', snapshot).then(() => {
			expect(noticeLog).toHaveLength(1);
			expect(noticeLog[0]).toContain('moved or been deleted');
		});
	});

	it('refuses the reply rather than appending it to the wrong marker', async () => {
		const h = makeHarnessWith(TWINS);
		const wrote = await h.service.appendReply(
			'note.md',
			secondOf(h.content),
			{
				author: 'charles',
				date: '2026-06-22',
				body: 'mine',
			},
		);

		expect(wrote).toBe(false);
		expect(h.content).not.toContain('mine');
	});

	it('still acts on a unique id', async () => {
		const h = makeHarnessWith(
			TWINS.replace('[id=twin0001]', '[id=twin0002]'),
		);
		await h.service.resolveComment('note.md', secondOf(h.content));

		const resolved = parseAll(h.content).filter(
			(c) => c.resolution !== undefined,
		);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.body).toBe('the second one');
	});
});

// ---------------------------------------------------------------------------
// PR A item 3: the read-then-write window.
//
// Every verb computed splice offsets against one read, and applySplices then
// performed a SECOND read and applied those offsets to whatever came back. Both
// failure modes below were reproduced by execution in the 2026-08-04 review.
// ---------------------------------------------------------------------------

const TWO_COMMENTS = [
	'First paragraph. <!-- annoteca/clarify: which products?',
	'[id=aaaa1111]',
	'-->',
	'',
	'Second paragraph. <!-- annoteca/tone: too sharp?',
	'[id=bbbb2222]',
	'-->',
	'',
	'Closing prose.',
].join('\n');

// Same closed-file harness, plus a one-shot hook that fires immediately AFTER a
// read returns. That is precisely the race: the verb holds content it read a
// moment ago, and the file has moved on before the write lands.
function makeRacingHarness(initial: string) {
	let content = initial;
	let afterNextRead: (() => void) | undefined;
	const file = new TFile();
	const plugin = {
		settings: {
			enableAuthorTag: true,
			authorTag: 'charles',
			deleteOnResolve: false,
		},
		app: {
			vault: {
				getAbstractFileByPath: (p: string) =>
					p === 'note.md' ? file : null,
				read: () => {
					const snapshot = content;
					const hook = afterNextRead;
					afterNextRead = undefined;
					if (hook) hook();
					return Promise.resolve(snapshot);
				},
				process: (_file: TFile, fn: (data: string) => string) => {
					content = fn(content);
					return Promise.resolve(content);
				},
			},
			workspace: {
				getLeavesOfType: () => [],
				getActiveFile: () => null,
			},
		},
		commentIndex: { rebuild: () => undefined },
		events: { trigger: () => undefined },
	} as unknown as AnnotecaPlugin;
	return {
		service: new CommentService(plugin),
		get content() {
			return content;
		},
		set content(updated: string) {
			content = updated;
		},
		onceAfterRead(fn: () => void) {
			afterNextRead = fn;
		},
	};
}

// Editor-path twin of the harness above: the file is open in a markdown leaf, so
// the service reads and writes through the editor rather than the vault.
function makeEditorHarness(initial: string) {
	let content = initial;
	let afterNextGetValue: (() => void) | undefined;
	const file = new TFile();
	const editor = {
		getValue: () => {
			const snapshot = content;
			const hook = afterNextGetValue;
			afterNextGetValue = undefined;
			if (hook) hook();
			return snapshot;
		},
		// Offsets stand in for positions one-for-one, which is all this path
		// uses them for.
		offsetToPos: (n: number) => n,
		replaceRange: (insert: string, from: number, to: number) => {
			content = content.slice(0, from) + insert + content.slice(to);
		},
	};
	const view = Object.create(MarkdownView.prototype) as MarkdownView;
	Object.assign(view, { file: { path: 'note.md' }, editor });
	const plugin = {
		settings: {
			enableAuthorTag: true,
			authorTag: 'charles',
			deleteOnResolve: false,
		},
		app: {
			vault: {
				getAbstractFileByPath: (p: string) =>
					p === 'note.md' ? file : null,
				read: () => Promise.resolve(content),
				process: (_f: TFile, fn: (data: string) => string) => {
					content = fn(content);
					return Promise.resolve(content);
				},
			},
			workspace: {
				getLeavesOfType: () => [{ view }],
				getActiveFile: () => null,
			},
		},
		commentIndex: { rebuild: () => undefined },
		events: { trigger: () => undefined },
	} as unknown as AnnotecaPlugin;
	return {
		service: new CommentService(plugin),
		get content() {
			return content;
		},
		set content(updated: string) {
			content = updated;
		},
		onceAfterRead(fn: () => void) {
			afterNextGetValue = fn;
		},
	};
}

describe('applySplices refuses a write computed against stale content', () => {
	it('does not splice when the file changed between the read and the write', async () => {
		const h = makeRacingHarness(TWO_COMMENTS);
		const target = parseAll(h.content)[0];
		expect(target).toBeDefined();
		if (!target) return;

		// A sync (or another app) prepends a paragraph the instant after the
		// verb reads. Every offset the verb is holding is now short by that much.
		h.onceAfterRead(() => {
			h.content = `A paragraph that arrived from elsewhere.\n\n${h.content}`;
		});
		await h.service.resolveComment('note.md', target);

		// The external writer's version is intact: no `[resolved ...]` line was
		// spliced into the middle of it.
		expect(h.content.startsWith('A paragraph that arrived')).toBe(true);
		expect(h.content).not.toContain('[resolved');
		expect(noticeLog.join('\n')).toContain('moved or been deleted');

		// And the action is repeatable once the caller re-reads.
		const retry = parseAll(h.content)[0];
		expect(retry).toBeDefined();
		if (!retry) return;
		await h.service.resolveComment('note.md', retry);
		expect(h.content).toContain('[resolved charles');
	});

	it('refuses on the editor path too', async () => {
		// Same window, different write API: when the note is open the service
		// reads the editor's value and writes back through replaceRange, so the
		// comparison has to happen there as well.
		const h = makeEditorHarness(TWO_COMMENTS);
		const target = parseAll(h.content)[0];
		expect(target).toBeDefined();
		if (!target) return;

		h.onceAfterRead(() => {
			h.content = `Typed above the marker.\n\n${h.content}`;
		});
		await h.service.resolveComment('note.md', target);

		expect(h.content.startsWith('Typed above the marker.')).toBe(true);
		expect(h.content).not.toContain('[resolved');
		expect(noticeLog.join('\n')).toContain('moved or been deleted');

		const retry = parseAll(h.content)[0];
		expect(retry).toBeDefined();
		if (!retry) return;
		await h.service.resolveComment('note.md', retry);
		expect(h.content).toContain('[resolved charles');
	});
});

describe('two lifecycle writes to one file do not lose each other', () => {
	it('applies both resolves when they overlap', async () => {
		const h = makeRacingHarness(TWO_COMMENTS);
		const [first, second] = parseAll(h.content);
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (!first || !second) return;

		// Executed failure: both reported "Resolved." and only one landed,
		// because the second verb read before the first one wrote and then
		// spliced its offsets into the newer text.
		await Promise.all([
			h.service.resolveComment('note.md', first),
			h.service.resolveComment('note.md', second),
		]);

		const after = parseAll(h.content);
		expect(after).toHaveLength(2);
		expect(after[0]?.resolution).toBeDefined();
		expect(after[1]?.resolution).toBeDefined();
		expect(h.content).toContain('Closing prose.');
	});
});

describe('a refused write is reported as a refusal, not a success', () => {
	it('appendReply returns false so the composer keeps the reply', async () => {
		// The staleness guard refuses correctly, but a refusal that does not
		// reach the caller is indistinguishable from a success one layer up:
		// appendReply returned true, the popover said "Reply added." and cleared
		// the draft, and the reply the user had just typed was gone with nothing
		// written to the file.
		const h = makeRacingHarness(TWO_COMMENTS);
		const target = parseAll(h.content)[0];
		expect(target).toBeDefined();
		if (!target) return;

		h.onceAfterRead(() => {
			h.content = `Arrived from elsewhere.\n\n${h.content}`;
		});
		const wrote = await h.service.appendReply('note.md', target, {
			author: 'charles',
			date: '2026-08-04T10:00:00',
			body: 'a reply the user typed',
		});

		expect(wrote).toBe(false);
		expect(h.content).not.toContain('a reply the user typed');
	});

	it('deleteAllResolvedInFile returns null rather than a count', async () => {
		const resolvedDoc = [
			'Prose. <!-- annoteca/clarify: done with this',
			'[id=cccc3333]',
			'[resolved charles 2026-08-01T10:00:00]:',
			'-->',
			'',
			'More prose.',
		].join('\n');
		const h = makeRacingHarness(resolvedDoc);
		h.onceAfterRead(() => {
			h.content = `Arrived from elsewhere.\n\n${h.content}`;
		});
		const removed = await h.service.deleteAllResolvedInFile('note.md');
		expect(removed).toBeNull();
		expect(h.content).toContain('annoteca/clarify');
	});
});
