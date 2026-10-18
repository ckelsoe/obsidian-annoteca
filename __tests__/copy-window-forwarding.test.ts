/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><div></div><span></span><button></button><textarea></textarea><select><option></option></select><p></p></div></body></html>"}
 */
// Every copy button hands the plugin the window it was clicked in. The
// clipboard is written through that window's navigator, because in a pop-out
// the main document is unfocused and a write through it is refused. These
// drive the real popover and the real Thread tab and click the buttons.

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { TFile, type App } from 'obsidian';

import {
	buildAnnotecaExtension,
	findMarkersInDoc,
	setTapPopoverEffect,
} from '../decorations';
import { ThreadTabRenderer } from '../hub-thread-tab';
import { CommentIndex } from '../index';
import { serialize } from '../parser';
import { DEFAULT_SETTINGS } from '../settings';
import { installObsidianDomHelpers } from '../__mocks__/obsidian';
import type AnnotecaPlugin from '../main';
import type { AnnotecaSettings, Comment } from '../types';
import { stubDecorationContext } from './stub-context';
import { at } from './helpers/checked';

const DOC = `Prose. ${serialize({ id: 'aaaaaaaa', category: 'clarify', body: 'copy me' })} after.`;

beforeAll(() => {
	installObsidianDomHelpers();
	window.activeDocument = document;
	window.activeWindow = window;
});

afterEach(() => {
	document.body.replaceChildren();
});

const settle = (): Promise<void> =>
	new Promise((resolve) => {
		window.setTimeout(resolve, 30);
	});

const button = (root: ParentNode, label: string): HTMLElement => {
	const found = [
		...root.querySelectorAll<HTMLElement>(
			'.annoteca-hover-action, .annoteca-action-btn',
		),
	].find((b) => b.textContent === label);
	if (!found) throw new Error(`no ${label} button`);
	return found;
};

describe('popover copy buttons', () => {
	it('pass the popover window with Copy text and Copy ID', async () => {
		const settings: AnnotecaSettings = {
			...DEFAULT_SETTINGS,
			markerClickAction: 'popover',
			renderMarkdownBodies: false,
		};
		const calls: string[] = [];
		const ctx = {
			...stubDecorationContext(() => settings),
			copyText: (m: Comment, win: Window) => {
				calls.push(`text:${m.id ?? ''}:${String(win === window)}`);
			},
			copyPermalink: (m: Comment, win: Window) => {
				calls.push(`id:${m.id ?? ''}:${String(win === window)}`);
			},
		};
		const view = new EditorView({
			state: EditorState.create({
				doc: DOC,
				extensions: [buildAnnotecaExtension(ctx)],
			}),
			parent: document.body,
		});
		await settle();
		view.dispatch({
			effects: setTapPopoverEffect.of(
				at(findMarkersInDoc(DOC), 0).marker.start,
			),
		});
		await settle();

		button(document, 'Copy text').click();
		button(document, 'Copy ID').click();
		expect(calls).toEqual(['text:aaaaaaaa:true', 'id:aaaaaaaa:true']);
		view.destroy();
	});
});

describe('Thread tab copy buttons', () => {
	it('pass the panel window with Copy text, Copy ID and Copy all', () => {
		const path = 'notes/a.md';
		const index = new CommentIndex();
		index.rebuild(path, DOC);
		const calls: string[] = [];
		const record = (what: string) => (_x: unknown, win: Window) => {
			calls.push(`${what}:${String(win === window)}`);
			return Promise.resolve();
		};
		const tfile = (p: string): TFile =>
			Object.assign(new TFile(), {
				path: p,
				extension: 'md',
				basename: p,
			});
		const plugin = {
			settings: {
				...DEFAULT_SETTINGS,
				autoCollapseInactiveFiles: false,
				statusFilter: 'open',
				renderMarkdownBodies: false,
			},
			commentIndex: index,
			computeScopeFiles: () => new Set([path]),
			getScopeState: () => ({
				shape: { kind: 'file' },
				anchorPath: path,
				pinned: false,
			}),
			getDynamicScopeOptionsForActiveFile: () => ({
				properties: [],
				tags: [],
			}),
			navigateToOffset: () => Promise.resolve(),
			highlightActiveComment: () => undefined,
			isStarred: () => false,
			toggleStarred: () => undefined,
			loadDraft: () => '',
			saveDraft: () => undefined,
			clearDraft: () => undefined,
			copyCommentText: record('text'),
			copyCommentId: record('id'),
			copyCommentsText: record('all'),
		} as unknown as AnnotecaPlugin;
		const app = {
			workspace: { getActiveFile: () => tfile(path) },
			vault: { getAbstractFileByPath: (p: string) => tfile(p) },
			metadataCache: { getFileCache: () => null },
		} as unknown as App;
		const container = document.body.createDiv();
		const renderer = new ThreadTabRenderer(plugin, app, () => undefined);
		renderer.render(container);

		button(container, 'Copy text').click();
		button(container, 'Copy ID').click();
		container.querySelector<HTMLElement>('.annoteca-scope-copy')?.click();
		expect(calls).toEqual(['text:true', 'id:true', 'all:true']);
	});
});
