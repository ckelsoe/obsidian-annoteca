import { TFile } from 'obsidian';

import type AnnotecaPlugin from '../main';
import { CommentService } from '../comment-service';
import { parseAll } from '../parser';

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
				modify: (_file: TFile, updated: string) => {
					content = updated;
					return Promise.resolve();
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
				getAbstractFileByPath: () => file,
				read: () => Promise.resolve(content),
				modify: (_file: TFile, updated: string) => {
					content = updated;
					return Promise.resolve();
				},
			},
			workspace: { getLeavesOfType: () => [], getActiveFile: () => null },
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
