/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><div></div></div></body></html>"}
 */
// Opening a comment from a note in a pop-out window. A pop-out has no
// sidebar, so the hub would open in the main window, behind the note, on
// whatever note the main window has open (Ed's report on 1.20.0-beta.4). The
// comment opens in its own tab beside the note in the pop-out instead, and a
// comment without a unique id, which that tab cannot find, gets a notice
// rather than the wrong panel.

import { MarkdownView } from 'obsidian';
import { installObsidianDomHelpers, noticeLog } from '../__mocks__/obsidian';
import AnnotecaPlugin from '../main';
import { CommentIndex } from '../index';
import { serializeLeanMarker } from '../parser';
import type { Comment } from '../types';

// Debug mode off: the plugin asks before timing anything.
const QUIET_DEBUG = { enabled: false, log: () => undefined };

interface PluginUnderTest {
	openReviewerOnComment(
		comment: Comment,
		path?: string,
		from?: HTMLElement,
	): void;
}

const PATH = 'notes/a.md';

function comment(id: string | undefined): Comment {
	return {
		...(id ? { id } : {}),
		category: 'clarify',
		body: 'b',
		marker: { start: 5, end: 15 },
	} as Comment;
}

// The note's editor text, holding one marker per id given. The id check
// reads this, not the index, so a comment saved a moment ago counts.
function textWith(ids: string[]): string {
	return ids
		.map((id) => `Line ${serializeLeanMarker('clarify', id)}`)
		.join('\n');
}

// A markdown leaf showing the note. Its container element is real DOM, so a
// click target inside it is found the way the production code finds it.
function noteLeaf(
	inPopout: boolean,
	splits: { root: object; popout: object },
	text: string,
) {
	const containerEl = document.body.createDiv();
	const editorEl = containerEl.createDiv();
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path: PATH },
		containerEl,
		editor: { getValue: () => text },
	}) as MarkdownView;
	const leaf = {
		view,
		getContainer: () => (inPopout ? splits.popout : splits.root),
	};
	Object.assign(view, { leaf });
	return { leaf, editorEl };
}

function setup(opts: {
	inPopout: boolean;
	ids: string[];
	// The leaf Obsidian reports as most recent, when it is not the note's.
	recentInMain?: boolean;
}) {
	const splits = { root: {}, popout: {} };
	const text = textWith(opts.ids);
	const note = noteLeaf(opts.inPopout, splits, text);
	const main = noteLeaf(false, splits, text);
	// Empty, as when the comment was typed after the note was last indexed.
	const commentIndex = new CommentIndex();
	const calls = {
		tab: [] as unknown[][],
		// The ids the index held for the note when the tab opened: the tab
		// looks its comment up there.
		indexedAtOpen: [] as (string | undefined)[][],
		hub: 0,
		highlight: [] as unknown[][],
		changed: [] as unknown[],
	};
	const plugin = Object.create(
		AnnotecaPlugin.prototype,
	) as unknown as PluginUnderTest;
	Object.assign(plugin, {
		debug: QUIET_DEBUG,
		commentIndex,
		events: {
			trigger: (name: string, payload: unknown) => {
				if (name === 'index-changed') calls.changed.push(payload);
			},
		},
		app: {
			vault: { getAbstractFileByPath: () => null },
			workspace: {
				rootSplit: splits.root,
				getMostRecentLeaf: () =>
					opts.recentInMain ? main.leaf : note.leaf,
				getLeavesOfType: (type: string) =>
					type === 'markdown' ? [main.leaf, note.leaf] : [],
				getActiveFile: () => null,
			},
		},
		openCommentInTab: (...args: unknown[]) => {
			calls.tab.push(args);
			calls.indexedAtOpen.push(
				(commentIndex.get(PATH)?.comments ?? []).map((c) => c.id),
			);
		},
		activateView: () => {
			calls.hub += 1;
			return Promise.resolve();
		},
		highlightActiveComment: (...args: unknown[]) =>
			calls.highlight.push(args),
		captureEditorScrollForPath: () => () => undefined,
	});
	return { plugin, note, main, calls };
}

beforeAll(() => {
	installObsidianDomHelpers();
});

beforeEach(() => {
	noticeLog.length = 0;
});

describe('openReviewerOnComment from a pop-out note', () => {
	it('opens the comment in its own tab beside the pop-out note', () => {
		const c = comment('aaaaaaaa');
		const { plugin, note, calls } = setup({
			inPopout: true,
			ids: ['aaaaaaaa'],
		});
		plugin.openReviewerOnComment(c, PATH, note.editorEl);
		expect(calls.tab).toHaveLength(1);
		expect(calls.tab[0]?.[0]).toBe(PATH);
		expect(calls.tab[0]?.[1]).toBe(c);
		expect(calls.tab[0]?.[2]).toBe(note.leaf);
		expect(calls.highlight).toEqual([[PATH, 5]]);
		// Indexed from the editor before the tab opened, and announced.
		expect(calls.indexedAtOpen).toEqual([['aaaaaaaa']]);
		expect(calls.changed).toEqual([{ path: PATH }]);
		expect(calls.hub).toBe(0);
		expect(noticeLog).toEqual([]);
	});

	it('shows a notice, not the main window hub, for a comment with no id', () => {
		const { plugin, note, calls } = setup({ inPopout: true, ids: [] });
		plugin.openReviewerOnComment(comment(undefined), PATH, note.editorEl);
		expect(calls.tab).toEqual([]);
		expect(calls.hub).toBe(0);
		expect(noticeLog).toHaveLength(1);
		expect(noticeLog[0]).toMatch(/no unique ID/);
	});

	it('treats a duplicated id like no id', () => {
		const { plugin, note, calls } = setup({
			inPopout: true,
			ids: ['aaaaaaaa', 'aaaaaaaa'],
		});
		plugin.openReviewerOnComment(comment('aaaaaaaa'), PATH, note.editorEl);
		expect(calls.tab).toEqual([]);
		expect(calls.hub).toBe(0);
		expect(noticeLog).toHaveLength(1);
	});

	// A hover popover does not activate its note's leaf, so the most recent
	// leaf can be the same note open in the main window. The popover passes
	// the editor it is in, and that decides.
	it('uses the editor a popover click came from over the most recent leaf', () => {
		const c = comment('aaaaaaaa');
		const { plugin, note, calls } = setup({
			inPopout: true,
			ids: ['aaaaaaaa'],
			recentInMain: true,
		});
		plugin.openReviewerOnComment(c, PATH, note.editorEl);
		expect(calls.tab).toHaveLength(1);
		expect(calls.tab[0]?.[0]).toBe(PATH);
		expect(calls.tab[0]?.[1]).toBe(c);
		expect(calls.tab[0]?.[2]).toBe(note.leaf);
		expect(calls.hub).toBe(0);
	});

	it('opens the hub for a click from the main window copy of the note', () => {
		const { plugin, main, calls } = setup({
			inPopout: true,
			ids: ['aaaaaaaa'],
		});
		plugin.openReviewerOnComment(comment('aaaaaaaa'), PATH, main.editorEl);
		expect(calls.tab).toEqual([]);
		expect(calls.hub).toBe(1);
	});

	// A click in the hub moves focus to the note, so the pop-out note is the
	// most recent leaf by the time the hub asks. Without an origin the hub
	// keeps the click: a tab in the pop-out would take it away from the panel
	// the reader clicked in.
	it('keeps a hub click in the hub when the note is in a pop-out', () => {
		const { plugin, calls } = setup({
			inPopout: true,
			ids: ['aaaaaaaa'],
		});
		plugin.openReviewerOnComment(comment('aaaaaaaa'), PATH);
		expect(calls.tab).toEqual([]);
		expect(calls.hub).toBe(1);
		expect(noticeLog).toEqual([]);
	});

	it('opens the hub as before for a note in the main window', () => {
		const { plugin, calls } = setup({
			inPopout: false,
			ids: ['aaaaaaaa'],
		});
		plugin.openReviewerOnComment(comment('aaaaaaaa'), PATH);
		expect(calls.tab).toEqual([]);
		expect(calls.hub).toBe(1);
		expect(noticeLog).toEqual([]);
	});
});

// The comment tab starts the one-time vault scan when it opens. Reading saved
// bytes there would replace an entry just indexed from the editor with older
// text, and the tab would lose the comment it was opened on.
describe('scanVaultIfNeeded', () => {
	it('indexes an open note from its editor, not its saved bytes', async () => {
		const commentIndex = new CommentIndex();
		const plugin = Object.create(AnnotecaPlugin.prototype) as unknown as {
			scanVaultIfNeeded(): Promise<void>;
		};
		Object.assign(plugin, {
			debug: QUIET_DEBUG,
			commentIndex,
			vaultScanned: false,
			events: { trigger: () => undefined },
			app: {
				vault: {
					getMarkdownFiles: () => [{ path: PATH }],
					cachedRead: () =>
						Promise.resolve('Saved before the comment.'),
				},
			},
			comments: {
				currentNoteText: () =>
					Promise.resolve({ text: textWith(['bbbbbbbb']) }),
			},
		});
		await plugin.scanVaultIfNeeded();
		expect(commentIndex.get(PATH)?.comments.map((c) => c.id)).toEqual([
			'bbbbbbbb',
		]);
	});

	function scanSetup(read: () => Promise<{ text: string }>) {
		const commentIndex = new CommentIndex();
		const plugin = Object.create(AnnotecaPlugin.prototype) as unknown as {
			scanVaultIfNeeded(): Promise<void>;
		};
		Object.assign(plugin, {
			debug: QUIET_DEBUG,
			commentIndex,
			vaultScanned: false,
			events: { trigger: () => undefined },
			app: { vault: { getMarkdownFiles: () => [{ path: PATH }] } },
			comments: { currentNoteText: read },
		});
		return { plugin, commentIndex };
	}
	const ids = (index: CommentIndex) =>
		index.get(PATH)?.comments.map((c) => c.id);

	it('keeps an entry already indexed', async () => {
		const t = scanSetup(() =>
			Promise.resolve({ text: textWith(['bbbbbbbb']) }),
		);
		t.commentIndex.rebuild(PATH, textWith(['aaaaaaaa']));
		await t.plugin.scanVaultIfNeeded();
		expect(ids(t.commentIndex)).toEqual(['aaaaaaaa']);
	});

	it('keeps an entry indexed while the scan was reading', async () => {
		const t = scanSetup(() => {
			// The pop-out route indexes the editor while the read is pending.
			t.commentIndex.rebuild(PATH, textWith(['aaaaaaaa']));
			return Promise.resolve({ text: textWith(['bbbbbbbb']) });
		});
		await t.plugin.scanVaultIfNeeded();
		expect(ids(t.commentIndex)).toEqual(['aaaaaaaa']);
	});
});

// In a pop-out the comment tab stands in for the side panel, so stepping from
// comment to comment (next and previous, or clicking marker after marker)
// moves one tab rather than opening a tab per comment.
describe('openCommentInTab beside a pop-out note', () => {
	function tabsSetup() {
		const popout = {};
		const elsewhere = {};
		const made: { state: unknown }[] = [];
		const tabLeaf = (container: object, id: string) => {
			const leaf = {
				state: { path: PATH, id } as unknown,
				getContainer: () => container,
				getViewState: () => ({ state: leaf.state }),
				setViewState: (vs: { state: unknown }) => {
					leaf.state = vs.state;
					return Promise.resolve();
				},
			};
			return leaf;
		};
		const tabs: ReturnType<typeof tabLeaf>[] = [];
		const plugin = Object.create(AnnotecaPlugin.prototype) as unknown as {
			openCommentInTab(path: string, c: Comment, beside?: unknown): void;
		};
		Object.assign(plugin, {
			debug: QUIET_DEBUG,
			app: {
				workspace: {
					getLeavesOfType: () => tabs,
					revealLeaf: () => Promise.resolve(),
					createLeafBySplit: () => {
						const leaf = tabLeaf(popout, '');
						made.push(leaf);
						tabs.push(leaf);
						return leaf;
					},
					getLeaf: () => {
						throw new Error(
							'a pop-out tab must not open in the main area',
						);
					},
				},
			},
		});
		const beside = { getContainer: () => popout };
		return { plugin, tabs, made, beside, tabLeaf, popout, elsewhere };
	}

	it('points the pop-out comment tab at the next comment', () => {
		const t = tabsSetup();
		t.tabs.push(t.tabLeaf(t.popout, 'aaaaaaaa'));
		t.plugin.openCommentInTab(PATH, comment('bbbbbbbb'), t.beside);
		expect(t.made).toEqual([]);
		expect(t.tabs.map((l) => l.state)).toEqual([
			{ path: PATH, id: 'bbbbbbbb' },
		]);
	});

	it('leaves a comment tab in another window alone and opens one here', () => {
		const t = tabsSetup();
		t.tabs.push(t.tabLeaf(t.elsewhere, 'aaaaaaaa'));
		t.plugin.openCommentInTab(PATH, comment('bbbbbbbb'), t.beside);
		expect(t.made).toHaveLength(1);
		expect(t.tabs.map((l) => l.state)).toEqual([
			{ path: PATH, id: 'aaaaaaaa' },
			{ path: PATH, id: 'bbbbbbbb' },
		]);
	});
});

// Next and previous comment can cross into another note. The comment then
// opens where the jump landed, not where the command was run.
describe('jumpToAdjacentComment across notes', () => {
	function jumpSetup() {
		const OTHER = 'notes/b.md';
		const viewFor = (path: string) => {
			const containerEl = document.body.createDiv();
			return Object.assign(Object.create(MarkdownView.prototype), {
				file: { path },
				containerEl,
			}) as MarkdownView;
		};
		const here = viewFor(PATH);
		const there = viewFor(OTHER);
		let recent: { view: MarkdownView } = { view: here };
		const opened: { path?: string; from?: HTMLElement }[] = [];
		const index = new CommentIndex();
		index.rebuild(PATH, textWith(['aaaaaaaa']));
		index.rebuild(OTHER, textWith(['bbbbbbbb']));
		const plugin = Object.create(AnnotecaPlugin.prototype) as unknown as {
			jumpToAdjacentComment(
				editor: unknown,
				view: unknown,
				direction: 'next' | 'previous',
				unresolvedOnly: boolean,
			): Promise<void>;
		};
		Object.assign(plugin, {
			debug: QUIET_DEBUG,
			commentIndex: index,
			computeScopeFiles: () => [PATH, OTHER],
			navigateToOffset: (path: string) => {
				recent = { view: path === OTHER ? there : here };
				return Promise.resolve();
			},
			openReviewerOnComment: (
				_c: Comment,
				path?: string,
				from?: HTMLElement,
			) => opened.push({ path, from }),
			app: { workspace: { getMostRecentLeaf: () => recent } },
		});
		// The cursor sits past the note's only comment, so "next" crosses.
		const editor = {
			getCursor: () => ({ line: 0, ch: 0 }),
			posToOffset: () => 10_000,
		};
		return { plugin, here, there, opened, editor, OTHER };
	}

	it('opens a comment in another note from the view it landed in', async () => {
		const t = jumpSetup();
		await t.plugin.jumpToAdjacentComment(t.editor, t.here, 'next', false);
		expect(t.opened.map((o) => o.path)).toEqual([t.OTHER]);
		// Identity, not equality: two empty containers are deep-equal.
		expect(t.opened[0]?.from).toBe(t.there.containerEl);
	});
});
