/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><div></div><span></span><button></button><textarea></textarea><select><option></option></select><p></p></div></body></html>"}
 */
// #83: focus mode in the Thread tab. One comment, nothing else, until the
// reader asks for the list back or picks a different comment elsewhere.
//
// Drives the public render() into a real container and acts on rendered DOM.

import { TFile } from 'obsidian';

import { ThreadTabRenderer } from '../hub-thread-tab';
import { CommentIndex } from '../index';
import { DEFAULT_SETTINGS } from '../settings';
import { serialize } from '../parser';
import { installObsidianDomHelpers } from '../__mocks__/obsidian';
import type AnnotecaPlugin from '../main';
import type { App } from 'obsidian';
import type { Comment } from '../types';

const A = 'notes/a.md';
const B = 'notes/b.md';

const three = (lead: string, resolveSecond = false) =>
	`${lead}${serialize({ id: 'aaaaaaaa', category: 'clarify', body: 'first one' })}\n\n` +
	`${serialize({
		id: 'bbbbbbbb',
		category: 'clarify',
		body: 'second one',
		resolution: resolveSecond
			? { author: 'charles', date: '2026-10-01', note: 'done' }
			: undefined,
	})}\n\n` +
	`${serialize({ id: 'cccccccc', category: 'clarify', body: 'third one' })}`;

function harness(text: string = three('')) {
	const openedTabs: string[] = [];
	const index = new CommentIndex();
	index.rebuild(A, text);
	index.rebuild(
		B,
		serialize({ id: 'dddddddd', category: 'clarify', body: 'other note' }),
	);
	const tfile = (p: string): TFile =>
		Object.assign(new TFile(), { path: p, extension: 'md', basename: p });

	const plugin = {
		settings: {
			...DEFAULT_SETTINGS,
			autoCollapseInactiveFiles: false,
			statusFilter: 'open',
		},
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
		navigateToOffset: () => Promise.resolve(),
		highlightActiveComment: () => undefined,
		openCommentInTab: (path: string, c: Comment) => {
			openedTabs.push(`${path}:${c.id ?? ''}`);
		},
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
	const render = () => {
		container.replaceChildren();
		renderer.render(container);
	};
	const renderer: ThreadTabRenderer = new ThreadTabRenderer(
		plugin,
		app,
		render,
	);
	render();
	return { renderer, render, container, index, openedTabs };
}

const excerpts = (c: HTMLElement): string[] =>
	[...c.querySelectorAll('.annoteca-reviewer-excerpt')].map(
		(e) => e.textContent?.trim() ?? '',
	);

function commentAt(index: CommentIndex, path: string, i: number): Comment {
	const c = index.get(path)?.comments[i];
	if (!c) throw new Error(`no comment ${i} in ${path}`);
	return c;
}

// Expand the card with this body (chevron), then press its Focus action.
function focusOn(container: HTMLElement, body: string): void {
	const card = [
		...container.querySelectorAll<HTMLElement>('.annoteca-reviewer-card'),
	].find((c) => c.textContent?.includes(body));
	if (!card) throw new Error(`no card for ${body}`);
	if (!card.querySelector('.annoteca-reviewer-expanded'))
		card.querySelector<HTMLElement>('.annoteca-reviewer-chevron')?.click();
	const again = [
		...container.querySelectorAll<HTMLElement>('.annoteca-reviewer-card'),
	].find((c) => c.textContent?.includes(body));
	const btn = [
		...(again?.querySelectorAll<HTMLElement>('.annoteca-action-btn') ?? []),
	].find((b) => b.textContent === 'Focus');
	if (!btn) throw new Error(`no Focus button on ${body}`);
	btn.click();
}

const showAll = (container: HTMLElement): void => {
	const btn = container.querySelector<HTMLElement>('.annoteca-focus-exit');
	if (!btn) throw new Error('no Show all button');
	btn.click();
};

beforeAll(() => {
	installObsidianDomHelpers();
	window.activeDocument = document;
	window.activeWindow = window;
	Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
	document.body.replaceChildren();
});

describe('#83: focus mode', () => {
	it('shows only the focused comment, with no scope toolbar', () => {
		const h = harness();
		expect(excerpts(h.container)).toHaveLength(3);
		focusOn(h.container, 'second one');
		expect(h.renderer.isFocused).toBe(true);
		expect(excerpts(h.container)).toEqual(['second one']);
		expect(h.container.querySelector('.annoteca-scope-toolbar')).toBeNull();
		expect(
			h.container.querySelector('.annoteca-focus-label')?.textContent,
		).toBe(`One comment in ${A}`);
		// Expanded, so the whole conversation and the composer are there.
		expect(
			h.container.querySelector('.annoteca-reviewer-expanded'),
		).not.toBeNull();
	});

	it('hides the Focus action while focused', () => {
		const h = harness();
		focusOn(h.container, 'second one');
		const labels = [
			...h.container.querySelectorAll('.annoteca-action-btn'),
		].map((b) => b.textContent);
		expect(labels).not.toContain('Focus');
		expect(labels).toContain('Resolve');
	});

	it('Show all brings the list back with the comment still selected', () => {
		const h = harness();
		focusOn(h.container, 'second one');
		showAll(h.container);
		expect(h.renderer.isFocused).toBe(false);
		expect(excerpts(h.container)).toHaveLength(3);
		expect(
			h.container
				.querySelector(
					'.annoteca-reviewer-card.is-active .annoteca-reviewer-excerpt',
				)
				?.textContent?.trim(),
		).toBe('second one');
	});

	it('keeps the comment after it is resolved, though the filter is Open', () => {
		const h = harness();
		focusOn(h.container, 'second one');
		h.index.rebuild(A, three('', true));
		h.render();
		expect(excerpts(h.container)).toEqual(['second one']);
	});

	it('follows the comment when text is typed above it', () => {
		const h = harness();
		focusOn(h.container, 'third one');
		h.index.rebuild(A, three('abcd'));
		h.render();
		expect(excerpts(h.container)).toEqual(['third one']);
		expect(h.renderer.activeStart).toBe(
			commentAt(h.index, A, 2).marker.start,
		);
	});

	it('says so when the comment is gone, and Show all still works', () => {
		const h = harness();
		focusOn(h.container, 'second one');
		h.index.rebuild(
			A,
			serialize({
				id: 'aaaaaaaa',
				category: 'clarify',
				body: 'first one',
			}),
		);
		h.render();
		expect(excerpts(h.container)).toEqual([]);
		expect(
			h.container.querySelector('.annoteca-empty')?.textContent,
		).toContain('no longer in the note');
		showAll(h.container);
		expect(excerpts(h.container)).toEqual(['first one']);
	});

	it('stays focused when the reader switches to another note', () => {
		const h = harness();
		focusOn(h.container, 'second one');
		h.renderer.setActiveComment(B, undefined);
		h.render();
		expect(excerpts(h.container)).toEqual(['second one']);
	});

	it('leaves focus when a different comment is picked in the editor', () => {
		const h = harness();
		focusOn(h.container, 'second one');
		h.renderer.leaveFocusUnlessSelected(
			A,
			commentAt(h.index, A, 0).marker.start,
		);
		expect(h.renderer.isFocused).toBe(false);
	});

	it('stays focused when the focused comment itself is picked', () => {
		const h = harness();
		focusOn(h.container, 'second one');
		h.renderer.leaveFocusUnlessSelected(
			A,
			commentAt(h.index, A, 1).marker.start,
		);
		expect(h.renderer.isFocused).toBe(true);
	});

	it('follows a rename of the note, and of a folder above it', () => {
		const h = harness();
		focusOn(h.container, 'second one');
		h.index.rename(A, 'notes/renamed.md');
		h.renderer.rekeyFocusOnRename(A, 'notes/renamed.md');
		h.render();
		expect(excerpts(h.container)).toEqual(['second one']);

		h.index.rename('notes/renamed.md', 'moved/renamed.md');
		h.renderer.rekeyFocusOnRename('notes', 'moved');
		h.render();
		expect(excerpts(h.container)).toEqual(['second one']);
	});
});

describe('#83: focus mode and the keyboard', () => {
	it('the Focus action has an accessible name', () => {
		const h = harness();
		const card = h.container.querySelector(
			'.annoteca-reviewer-card.is-active',
		);
		const btn = card?.querySelector('.annoteca-focus-enter');
		expect(btn?.getAttribute('aria-label')).toBe('Focus on this comment');
	});

	it('entering focus puts the keyboard on Show all', () => {
		const h = harness();
		focusOn(h.container, 'second one');
		expect(document.activeElement).toBe(
			h.container.querySelector('.annoteca-focus-exit'),
		);
	});

	it("Show all puts the keyboard back on that comment's Focus button", () => {
		const h = harness();
		focusOn(h.container, 'second one');
		showAll(h.container);
		const active = h.container.querySelector(
			'.annoteca-reviewer-card.is-active',
		);
		expect(active?.textContent).toContain('second one');
		expect(document.activeElement).toBe(
			active?.querySelector('.annoteca-focus-enter'),
		);
	});
});

describe('#83: focus survives editing a comment that has no id', () => {
	const idless = (body: string) =>
		`${serialize({ category: 'clarify', body: 'other' })}\n\n` +
		serialize({ category: 'clarify', body });

	it('keeps showing it after its text changes in place', () => {
		const h = harness(idless('before edit'));
		focusOn(h.container, 'before edit');
		h.index.rebuild(A, idless('after edit'));
		h.render();
		expect(excerpts(h.container)).toEqual(['after edit']);
	});

	it('stays focused when the edit reselects it', () => {
		const h = harness(idless('before edit'));
		focusOn(h.container, 'before edit');
		const start = commentAt(h.index, A, 1).marker.start;
		h.index.rebuild(A, idless('after edit'));
		h.renderer.leaveFocusUnlessSelected(A, start);
		expect(h.renderer.isFocused).toBe(true);
	});
});

describe('#83: Open in tab', () => {
	it('a comment with an id offers its own tab, and opens it', () => {
		const h = harness();
		const btn = h.container.querySelector<HTMLElement>(
			'.annoteca-reviewer-card.is-active .annoteca-open-tab',
		);
		expect(btn?.getAttribute('aria-label')).toBe(
			'Open this comment in its own tab',
		);
		btn?.click();
		expect(h.openedTabs).toEqual([`${A}:aaaaaaaa`]);
	});

	it('an id-less comment does not, since a saved tab could not find it', () => {
		const h = harness(
			serialize({ category: 'clarify', body: 'no id here' }),
		);
		expect(
			h.container.querySelector('.annoteca-reviewer-expanded'),
		).not.toBeNull();
		expect(h.container.querySelector('.annoteca-open-tab')).toBeNull();
	});
});
