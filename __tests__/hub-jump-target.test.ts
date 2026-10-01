/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><div></div><span></span><button></button><textarea></textarea><select><option></option></select></div></body></html>"}
 */
// #82: the Thread tab's "Original text" block jumps to its comment in the note,
// and every way into the document from a card moves the editor's active
// highlight with it.
//
// Drives the public render() into a real container and acts on rendered DOM,
// so what is under test is the renderer rather than a restatement of it.

import { TFile } from 'obsidian';

import { ThreadTabRenderer } from '../hub-thread-tab';
import { CommentIndex } from '../index';
import { DEFAULT_SETTINGS } from '../settings';
import { installObsidianDomHelpers } from '../__mocks__/obsidian';
import type AnnotecaPlugin from '../main';
import type { App } from 'obsidian';

const A = 'notes/a.md';

const ADDRESSED_DOC = [
	'<!-- annoteca/clarify: tighten this',
	'[id=addr0001]',
	'[addressed claude 2026-06-20]: replaced the sentence',
	'```annoteca-original',
	'The old sentence.',
	'```',
	'--> The new sentence.',
	'',
	'More prose.',
].join('\n');

function harness(navigate: () => Promise<void> = () => Promise.resolve()) {
	const index = new CommentIndex();
	index.rebuild(A, ADDRESSED_DOC);
	const tfile = (p: string): TFile =>
		Object.assign(new TFile(), { path: p, extension: 'md', basename: p });

	const navigateToOffset = jest.fn(
		(_path: string, _offset: number, _force?: boolean) => navigate(),
	);
	const highlightActiveComment = jest.fn(
		(_path: string, _start: number | null) => undefined,
	);
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, statusFilter: 'all' },
		commentIndex: index,
		computeScopeFiles: () => new Set([A]),
		getScopeState: () => ({
			shape: { kind: 'file' },
			anchorPath: A,
			pinned: false,
		}),
		getDynamicScopeOptionsForActiveFile: () => ({
			properties: [],
			tags: [],
		}),
		navigateToOffset,
		highlightActiveComment,
		isStarred: () => false,
		toggleStarred: () => undefined,
		loadDraft: () => '',
		saveDraft: () => undefined,
		clearDraft: () => undefined,
	} as unknown as AnnotecaPlugin;

	const app = {
		workspace: { getActiveFile: () => tfile(A) },
		vault: { getAbstractFileByPath: (p: string) => tfile(p) },
		metadataCache: { getFileCache: () => null },
	} as unknown as App;

	const container = document.body.createDiv();
	const renderer = new ThreadTabRenderer(plugin, app, () => undefined);
	renderer.render(container);
	const comment = index.get(A)?.comments[0];
	if (!comment) throw new Error('fixture has no comment');
	return {
		container,
		renderer,
		index,
		start: comment.marker.start,
		navigateToOffset,
		highlightActiveComment,
	};
}

function originalEl(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>(
		'.annoteca-reviewer-addressed-original',
	);
	if (!el) throw new Error('original text block not rendered');
	return el;
}

// The highlight follows the navigation promise, so let it settle.
const settle = () => new Promise<void>((r) => window.setTimeout(r, 0));

beforeAll(() => {
	installObsidianDomHelpers();
	window.activeDocument = document;
	window.activeWindow = window;
	// jsdom has no layout, so no scrollIntoView. The panel's reverse-sync
	// calls it on the next animation frame, which these tests wait past.
	Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
	window.getSelection()?.removeAllRanges();
	document.body.replaceChildren();
});

describe('#82: the original text jumps to its comment', () => {
	it('is exposed as a keyboard-reachable button', () => {
		const el = originalEl(harness().container);
		expect(el.textContent).toBe('The old sentence.');
		expect(el.getAttribute('role')).toBe('button');
		expect(el.getAttribute('tabindex')).toBe('0');
		expect(el.getAttribute('aria-label')).toBe(
			'Go to this comment in the note',
		);
	});

	it('a click navigates to the marker, forced, and highlights it', async () => {
		const h = harness();
		originalEl(h.container).click();
		await settle();
		expect(h.navigateToOffset).toHaveBeenCalledWith(A, h.start, true);
		expect(h.highlightActiveComment).toHaveBeenCalledWith(A, h.start);
	});

	it('Enter and Space jump; other keys do not', () => {
		const h = harness();
		const el = originalEl(h.container);
		el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
		expect(h.navigateToOffset).not.toHaveBeenCalled();
		el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
		expect(h.navigateToOffset).toHaveBeenCalledTimes(2);
	});

	it('a drag that starts outside and ends inside it does not jump', () => {
		const h = harness();
		const el = originalEl(h.container);
		const text = el.firstChild;
		const outside = h.container.querySelector(
			'.annoteca-reviewer-excerpt',
		)?.firstChild;
		if (!text || !outside) throw new Error('missing text nodes');
		const sel = window.getSelection();
		sel?.setBaseAndExtent(outside, 0, text, 3);
		expect(sel?.anchorNode).toBe(outside);
		el.click();
		expect(h.navigateToOffset).not.toHaveBeenCalled();
	});

	it('jumps to where the comment is NOW, not where the card drew it', async () => {
		const h = harness();
		// An autosave rebuilds the index before the panel's queued refresh,
		// so the card still holds the old offset.
		h.index.rebuild(A, `Typed above.\n${ADDRESSED_DOC}`);
		originalEl(h.container).click();
		await settle();
		const moved = h.start + 'Typed above.\n'.length;
		expect(h.navigateToOffset).toHaveBeenCalledWith(A, moved, true);
		expect(h.highlightActiveComment).toHaveBeenCalledWith(A, moved);
	});

	it('a click that ends a text selection inside it does not jump', () => {
		const h = harness();
		const el = originalEl(h.container);
		const text = el.firstChild;
		if (!text) throw new Error('no text node');
		const range = document.createRange();
		range.setStart(text, 0);
		range.setEnd(text, 3);
		window.getSelection()?.addRange(range);
		el.click();
		expect(h.navigateToOffset).not.toHaveBeenCalled();
	});
});

describe('#82: a card click moves the editor highlight with the selection', () => {
	it('highlights the clicked comment after navigating', async () => {
		const h = harness();
		const compact = h.container.querySelector<HTMLElement>(
			'.annoteca-reviewer-compact',
		);
		if (!compact) throw new Error('no compact row');
		compact.click();
		await settle();
		expect(h.navigateToOffset).toHaveBeenCalledWith(A, h.start, false);
		expect(h.highlightActiveComment).toHaveBeenCalledWith(A, h.start);
	});
});

describe('#82: a highlight still in flight respects what happened meanwhile', () => {
	// Navigation that resolves only when the test says so.
	function deferred() {
		let resolve: () => void = () => undefined;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	it('does not highlight after the panel closed', async () => {
		const nav = deferred();
		const h = harness(() => nav.promise);
		originalEl(h.container).click();
		h.renderer.close();
		nav.resolve();
		await settle();
		expect(h.highlightActiveComment).not.toHaveBeenCalled();
	});

	it('does not highlight after another comment was selected', async () => {
		const nav = deferred();
		const h = harness(() => nav.promise);
		originalEl(h.container).click();
		h.renderer.setActiveComment(A, h.start + 1);
		nav.resolve();
		await settle();
		expect(h.highlightActiveComment).not.toHaveBeenCalled();
	});

	it('a failed navigation highlights nothing and does not throw', async () => {
		const h = harness(() => Promise.reject(new Error('gone')));
		originalEl(h.container).click();
		await settle();
		expect(h.highlightActiveComment).not.toHaveBeenCalled();
	});
});
