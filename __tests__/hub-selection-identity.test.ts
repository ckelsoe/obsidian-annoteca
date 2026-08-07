/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><div></div><span></span><button></button><textarea></textarea><select><option></option></select></div></body></html>"}
 */
// M10 and m3, both about the Thread tab naming things by offset.
//
// M10: `activeStart` is a raw document offset and the index is rebuilt on every
// autosave, so anything typed above the selection moves it. `stillValid` then
// failed and the panel silently fell back to the FIRST comment in the group,
// while the editor's own highlight (which does remap) went on painting the one
// the user chose, so the two disagreed about what was selected. The same offset
// keyed `cardExpandOverrides`, so a card opened with the chevron collapsed on
// the next autosave.
//
// m3: `currentScopeOptionValue` collapsed EVERY file-kind scope to the literal
// 'file', which is also the unconditional first option, so the mismatch branch
// could never fire for one and `describeScope`'s `case 'file'` was unreachable.
// A scope pinned to one note while another is open read "This file" while
// listing a different file's comments.
//
// Drives the PUBLIC render() into a real container and asserts on rendered DOM,
// so what is under test is the renderer rather than a restatement of it.

import { TFile } from 'obsidian';

import { ThreadTabRenderer } from '../hub-thread-tab';
import { CommentIndex } from '../index';
import { DEFAULT_SETTINGS } from '../settings';
import { serialize } from '../parser';
import { installObsidianDomHelpers } from '../__mocks__/obsidian';
import type AnnotecaPlugin from '../main';
import type { App } from 'obsidian';
import type { ScopeState } from '../types';

const A = 'notes/a.md';
const OTHER = 'Archive/OldNote.md';

const three = (lead: string) =>
	`${lead}${serialize({ id: 'aaaaaaaa', category: 'clarify', body: 'first one' })}\n\n` +
	`${serialize({ id: 'bbbbbbbb', category: 'clarify', body: 'second one' })}\n\n` +
	`${serialize({ id: 'cccccccc', category: 'clarify', body: 'third one' })}`;

function harness(
	files: Record<string, string>,
	scope: ScopeState,
	activeFile: string | null,
) {
	const index = new CommentIndex();
	for (const [p, text] of Object.entries(files)) index.rebuild(p, text);
	const tfile = (p: string): TFile =>
		Object.assign(new TFile(), { path: p, extension: 'md', basename: p });

	const plugin = {
		settings: { ...DEFAULT_SETTINGS, autoCollapseInactiveFiles: false },
		commentIndex: index,
		computeScopeFiles: () =>
			new Set(
				scope.shape.kind === 'file'
					? [scope.anchorPath]
					: Object.keys(files),
			),
		getScopeState: () => scope,
		getDynamicScopeOptionsForActiveFile: () => ({
			properties: [],
			tags: [],
		}),
		setScopeShape: () => Promise.resolve(),
		setStatusFilter: () => Promise.resolve(),
		togglePinScope: () => Promise.resolve(),
		navigateToOffset: () => Promise.resolve(),
		isStarred: () => false,
		toggleStarred: () => undefined,
		loadDraft: () => '',
		saveDraft: () => undefined,
		clearDraft: () => undefined,
	} as unknown as AnnotecaPlugin;

	const app = {
		workspace: {
			getActiveFile: () => (activeFile ? tfile(activeFile) : null),
		},
		vault: { getAbstractFileByPath: (p: string) => tfile(p) },
		metadataCache: { getFileCache: () => null },
	} as unknown as App;

	const container = document.body.createDiv();
	const renderer = new ThreadTabRenderer(plugin, app, () => undefined);
	const render = () => {
		container.replaceChildren();
		renderer.render(container);
	};
	return { renderer, render, container, index };
}

const activeBody = (c: HTMLElement): string =>
	c
		.querySelector(
			'.annoteca-reviewer-card.is-active .annoteca-reviewer-excerpt',
		)
		?.textContent?.trim() ?? '';

const expandedCount = (c: HTMLElement): number =>
	c.querySelectorAll('.annoteca-reviewer-expanded').length;

beforeAll(() => {
	installObsidianDomHelpers();
	window.activeDocument = document;
	window.activeWindow = window;
});

afterEach(() => {
	document.body.replaceChildren();
});

describe('M10: the selection follows the comment, not the offset', () => {
	const fileScope = (): ScopeState => ({
		shape: { kind: 'file' },
		anchorPath: A,
		pinned: false,
	});

	it('keeps the third comment selected after text is typed above it', () => {
		const { renderer, render, container, index } = harness(
			{ [A]: three('') },
			fileScope(),
			A,
		);
		const third = index.get(A)!.comments[2]!;
		renderer.setActiveComment(A, third.marker.start);
		render();
		expect(activeBody(container)).toContain('third one');

		// Exactly what an autosave does: four characters land at the top of the
		// note and the index is rebuilt, moving every offset below.
		index.rebuild(A, three('abcd'));
		render();

		expect(activeBody(container)).toContain('third one');
		expect(renderer.activeStart).toBe(
			index.get(A)!.comments[2]!.marker.start,
		);
	});

	it('keeps a card the user expanded expanded across that rebuild', () => {
		const { renderer, render, container, index } = harness(
			{ [A]: three('') },
			fileScope(),
			A,
		);
		renderer.setActiveComment(A, index.get(A)!.comments[0]!.marker.start);
		render();

		// Open the SECOND card with its chevron, which is not the active one.
		const chevrons = container.querySelectorAll<HTMLElement>(
			'.annoteca-reviewer-chevron',
		);
		expect(chevrons.length).toBeGreaterThan(1);
		chevrons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		render();
		const expandedBefore = expandedCount(container);
		expect(expandedBefore).toBeGreaterThan(0);

		index.rebuild(A, three('abcd'));
		render();

		expect(expandedCount(container)).toBe(expandedBefore);
	});

	it('does not jump to another file when a copied id exists in both', () => {
		// Copying a comment copies its id, so in a folder or vault scope the
		// same id can be unique WITHIN each of two files while being ambiguous
		// across them. Recovering by walking the groups in order would move the
		// selection to whichever file sorted first, which is worse than not
		// recovering at all.
		const shared = (body: string) =>
			serialize({ id: 'eeeeeeee', category: 'clarify', body });
		const BEE = 'Projects/b.md';
		const { renderer, render, container, index } = harness(
			{ [A]: shared('mine'), [BEE]: shared('the copy') },
			{ shape: { kind: 'vault' }, anchorPath: '', pinned: false },
			A,
		);
		renderer.setActiveComment(A, index.get(A)!.comments[0]!.marker.start);
		render();
		expect(activeBody(container)).toContain('mine');

		// Text lands above the selected comment in ITS file only.
		index.rebuild(A, `abcd${shared('mine')}`);
		render();

		expect(renderer.activePath).toBe(A);
		expect(activeBody(container)).toContain('mine');
	});

	it('keeps two files’ cards independent when they share a copied id', () => {
		const shared = (body: string) =>
			serialize({ id: 'eeeeeeee', category: 'clarify', body });
		const BEE = 'Projects/b.md';
		const { renderer, render, container, index } = harness(
			{ [A]: shared('mine'), [BEE]: shared('the copy') },
			{ shape: { kind: 'vault' }, anchorPath: '', pinned: false },
			A,
		);
		renderer.setActiveComment(A, index.get(A)!.comments[0]!.marker.start);
		render();

		// Chevron of the card holding a given body, so this does not depend on
		// the order the groups happen to sort in.
		const chevronFor = (body: string): HTMLElement => {
			const card = [
				...container.querySelectorAll<HTMLElement>(
					'.annoteca-reviewer-card',
				),
			].find((el) => el.textContent?.includes(body));
			if (!card) throw new Error(`no card for ${body}`);
			const ch = card.querySelector<HTMLElement>(
				'.annoteca-reviewer-chevron',
			);
			if (!ch) throw new Error(`no chevron for ${body}`);
			return ch;
		};
		const click = (body: string) => {
			chevronFor(body).dispatchEvent(
				new MouseEvent('click', { bubbles: true }),
			);
			render();
		};

		// Expand the copy, then collapse the original. Sharing one key means
		// the second click overwrites the first and BOTH end up collapsed.
		click('the copy');
		expect(expandedCount(container)).toBe(2);
		click('mine');

		expect(expandedCount(container)).toBe(1);
	});

	it('does not snap back to the previous card when a new selection does not resolve', () => {
		// setActiveComment names an OFFSET, because the events behind it carry
		// nothing else. If the remembered id survived that instruction, an
		// offset that does not resolve (the index is a beat behind the editor)
		// would recover the PREVIOUS selection and the panel would jump
		// backwards to a card the user has just moved off.
		const { renderer, render, container, index } = harness(
			{ [A]: three('') },
			fileScope(),
			A,
		);
		const third = index.get(A)!.comments[2]!;
		renderer.setActiveComment(A, third.marker.start);
		render();
		expect(activeBody(container)).toContain('third one');

		// A fresh instruction naming an offset no comment sits at.
		renderer.setActiveComment(A, 99999);
		render();

		expect(activeBody(container)).toContain('first one');
	});

	it('keeps an id-less card expanded when text lands above it', () => {
		// An id-less comment has no id to key on, so the card key falls back to
		// its text rather than its offset. Keyed by offset, any edit above
		// renamed the card and the expansion this whole change is about was
		// lost for exactly the comments "Convert comments" produces.
		const idless = (lead: string) =>
			`${lead}<!-- annoteca/clarify: first plain -->\n\n` +
			`<!-- annoteca/clarify: second plain -->`;
		const { renderer, render, container, index } = harness(
			{ [A]: idless('') },
			fileScope(),
			A,
		);
		renderer.setActiveComment(A, index.get(A)!.comments[0]!.marker.start);
		render();

		const secondCard = [
			...container.querySelectorAll<HTMLElement>(
				'.annoteca-reviewer-card',
			),
		].find((el) => el.textContent?.includes('second plain'))!;
		secondCard
			.querySelector<HTMLElement>('.annoteca-reviewer-chevron')!
			.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		render();
		const expandedBefore = expandedCount(container);
		expect(expandedBefore).toBeGreaterThan(0);

		index.rebuild(A, idless('abcd'));
		render();

		expect(expandedCount(container)).toBe(expandedBefore);
	});

	it('still falls back to the first comment when the selected one is deleted', () => {
		// The control. Without it, "follows the comment" could just mean
		// "never re-selects".
		const { renderer, render, container, index } = harness(
			{ [A]: three('') },
			fileScope(),
			A,
		);
		const third = index.get(A)!.comments[2]!;
		renderer.setActiveComment(A, third.marker.start);
		render();
		expect(activeBody(container)).toContain('third one');

		index.rebuild(
			A,
			`${serialize({ id: 'aaaaaaaa', category: 'clarify', body: 'first one' })}`,
		);
		render();

		expect(activeBody(container)).toContain('first one');
	});
});

describe('m3: the scope dropdown names the file it is actually showing', () => {
	function scopeLabel(container: HTMLElement): string {
		const sel = container.querySelector<HTMLSelectElement>('select');
		if (!sel) throw new Error('no scope dropdown');
		return sel.selectedOptions[0]?.textContent ?? '';
	}

	it('says "Pinned: <path>" when the pinned file is not the active one', () => {
		const { render, container } = harness(
			{
				[OTHER]: serialize({
					id: 'dddddddd',
					category: 'clarify',
					body: 'old note comment',
				}),
			},
			{ shape: { kind: 'file' }, anchorPath: OTHER, pinned: true },
			'Projects/B.md',
		);
		render();

		expect(scopeLabel(container)).toBe(`Pinned: ${OTHER}`);
	});

	it('still says "This file" when the scope is the active file', () => {
		// The control: the fix must not relabel the ordinary case.
		const { render, container } = harness(
			{
				[A]: serialize({
					id: 'aaaaaaaa',
					category: 'clarify',
					body: 'first one',
				}),
			},
			{ shape: { kind: 'file' }, anchorPath: A, pinned: false },
			A,
		);
		render();

		expect(scopeLabel(container)).toBe('This file');
	});
});
