/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><div></div><span></span><button></button><textarea></textarea><select><option></option></select><p></p></div></body></html>"}
 */
// #83: one comment in its own main-area tab. The view is the Thread tab's
// renderer held in focus, so these tests check what is DIFFERENT about it:
// saved state in and out, a standalone card with no way "back to the list",
// a title naming the category and id, and a rename carrying the tab along.

import { TFile } from 'obsidian';
import type { App, ViewStateResult, WorkspaceLeaf } from 'obsidian';

import {
	AnnotecaCommentView,
	commentTabState,
	rekeyCommentTabState,
} from '../views';
import { CommentIndex } from '../index';
import { DEFAULT_SETTINGS } from '../settings';
import { serialize } from '../parser';
import { installObsidianDomHelpers } from '../__mocks__/obsidian';
import type AnnotecaPlugin from '../main';

const A = 'notes/a.md';

function makeView(scan: () => Promise<void> = () => Promise.resolve()) {
	const index = new CommentIndex();
	index.rebuild(
		A,
		`${serialize({ id: 'aaaaaaaa', category: 'clarify', body: 'first one' })}\n\n` +
			serialize({
				id: 'bbbbbbbb',
				category: 'clarify',
				body: 'second one',
			}),
	);
	const drafts = new Map<string, string>();
	const tfile = (p: string): TFile =>
		Object.assign(new TFile(), { path: p, extension: 'md', basename: p });
	const plugin = {
		settings: { ...DEFAULT_SETTINGS },
		commentIndex: index,
		events: { on: () => ({}) },
		scanVaultIfNeeded: scan,
		navigateToOffset: () => Promise.resolve(),
		highlightActiveComment: () => undefined,
		openCommentInTab: () => undefined,
		isStarred: () => false,
		toggleStarred: () => undefined,
		loadDraft: (id: string) => drafts.get(id) ?? '',
		saveDraft: (id: string, body: string) => drafts.set(id, body),
		clearDraft: (id: string) => drafts.delete(id),
	} as unknown as AnnotecaPlugin;
	const app = {
		workspace: {
			getActiveFile: () => tfile(A),
		},
		vault: {
			getAbstractFileByPath: (p: string) => tfile(p),
		},
		metadataCache: { getFileCache: () => null },
	} as unknown as App;

	const view = new AnnotecaCommentView(
		{ app } as unknown as WorkspaceLeaf,
		plugin,
	);
	// The mock ItemView builds no containerEl, contentEl or header and has no
	// registerEvent; the real one has all of them.
	const containerEl = document.body.createDiv();
	containerEl.createDiv({
		cls: 'view-header-title',
		text: 'Annoteca comment',
	});
	const contentEl = containerEl.createDiv();
	Object.assign(view, {
		containerEl,
		contentEl,
		registerEvent: () => undefined,
	});
	return {
		view,
		index,
		contentEl,
		headerTitle: () =>
			containerEl.querySelector('.view-header-title')?.textContent,
	};
}

const tick = () => new Promise<void>((r) => queueMicrotask(r));
const result = {} as ViewStateResult;

beforeAll(() => {
	installObsidianDomHelpers();
	window.activeDocument = document;
	window.activeWindow = window;
	Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
	document.body.replaceChildren();
});

describe('commentTabState', () => {
	it('accepts a path and a well-formed id', () => {
		expect(commentTabState({ path: A, id: 'aaaaaaaa' })).toEqual({
			path: A,
			id: 'aaaaaaaa',
		});
	});

	it.each([
		null,
		'string',
		{},
		{ path: A },
		{ id: 'aaaaaaaa' },
		{ path: '', id: 'aaaaaaaa' },
		{ path: A, id: 'NOT-AN-ID' },
		{ path: A, id: 42 },
	])('rejects %p', (state) => {
		expect(commentTabState(state)).toBeUndefined();
	});
});

describe('the comment tab', () => {
	it('shows only its comment, with no way back to a list', async () => {
		const h = makeView();
		await h.view.onOpen();
		await h.view.setState({ path: A, id: 'bbbbbbbb' }, result);
		await tick();
		const excerpts = [
			...h.contentEl.querySelectorAll('.annoteca-reviewer-excerpt'),
		].map((e) => e.textContent?.trim());
		expect(excerpts).toEqual(['second one']);
		expect(h.contentEl.querySelector('.annoteca-focus-exit')).toBeNull();
		expect(h.contentEl.querySelector('.annoteca-focus-enter')).toBeNull();
		expect(h.contentEl.querySelector('.annoteca-open-tab')).toBeNull();
		// The whole conversation is there to work in.
		expect(
			h.contentEl.querySelector('.annoteca-reply-input'),
		).not.toBeNull();
	});

	it('is titled with the category and the id, and saves both', async () => {
		const h = makeView();
		await h.view.setState({ path: A, id: 'bbbbbbbb' }, result);
		expect(h.view.getDisplayText()).toBe('Clarify · bbbbbbbb');
		// The header Obsidian drew before the state arrived catches up.
		await tick();
		expect(h.headerTitle()).toBe('Clarify · bbbbbbbb');
		expect(h.view.getState()).toEqual({ path: A, id: 'bbbbbbbb' });
	});

	it('says so when its saved state is unusable', async () => {
		const h = makeView();
		await h.view.onOpen();
		await h.view.setState({ path: A, id: 'NOT VALID' }, result);
		await tick();
		expect(
			h.contentEl.querySelector('.annoteca-empty')?.textContent,
		).toContain('no comment to show');
		expect(h.view.getDisplayText()).toBe('Annoteca comment');
	});

	it('keeps the cursor in the reply box across a rebuild', async () => {
		const h = makeView();
		await h.view.onOpen();
		await h.view.setState({ path: A, id: 'bbbbbbbb' }, result);
		await tick();
		const box = h.contentEl.querySelector<HTMLTextAreaElement>(
			'.annoteca-reply-input',
		);
		if (!box) throw new Error('no reply box');
		box.value = 'half a reply';
		box.dispatchEvent(new Event('input'));
		box.focus();
		box.setSelectionRange(4, 6);
		// What an autosave of the note does: the index changes, the tab rebuilds.
		await h.view.setState({ path: A, id: 'bbbbbbbb' }, result);
		await tick();
		const again = h.contentEl.querySelector<HTMLTextAreaElement>(
			'.annoteca-reply-input',
		);
		expect(again).not.toBe(box);
		expect(document.activeElement).toBe(again);
		expect(again?.value).toBe('half a reply');
		expect([again?.selectionStart, again?.selectionEnd]).toEqual([4, 6]);
	});
});

describe('rekeyCommentTabState', () => {
	const state = { path: 'notes/a.md', id: 'bbbbbbbb' };

	it('follows a rename of the note', () => {
		expect(rekeyCommentTabState(state, 'notes/a.md', 'notes/b.md')).toEqual(
			{
				path: 'notes/b.md',
				id: 'bbbbbbbb',
			},
		);
	});

	it('follows a rename of a folder above it', () => {
		expect(rekeyCommentTabState(state, 'notes', 'moved')).toEqual({
			path: 'moved/a.md',
			id: 'bbbbbbbb',
		});
	});

	it('ignores an unrelated rename and an unusable state', () => {
		expect(rekeyCommentTabState(state, 'other.md', 'x.md')).toBeUndefined();
		expect(rekeyCommentTabState({}, 'notes', 'moved')).toBeUndefined();
	});
});

// Seen in the running app: Obsidian gives a restored tab a time limit to load,
// and a setState that awaited a slow first vault scan missed it, so the tab
// came back from a restart as an empty "New tab".
describe('the comment tab after a restart', () => {
	it('loads without waiting for the vault scan', async () => {
		const h = makeView(() => new Promise<void>(() => undefined));
		await h.view.onOpen();
		await h.view.setState({ path: A, id: 'bbbbbbbb' }, result);
		await tick();
		expect(h.contentEl.textContent).toContain('second one');
	});
});
