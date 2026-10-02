/**
 * @jest-environment jsdom
 */
// Opening a comment from a note in a pop-out window. A pop-out has no
// sidebar, so the hub would open in the main window, behind the note, on
// whatever note the main window has open (Ed's report on 1.20.0-beta.4). The
// comment opens in its own tab beside the note in the pop-out instead, and a
// comment without a unique id, which that tab cannot find, gets a notice
// rather than the wrong panel.

import { MarkdownView } from 'obsidian';
import { noticeLog } from '../__mocks__/obsidian';
import AnnotecaPlugin from '../main';
import type { Comment } from '../types';

interface PluginUnderTest {
	openReviewerOnComment(comment: Comment, path?: string): void;
}

const PATH = 'notes/a.md';

function comment(id: string | undefined, start: number): Comment {
	return {
		...(id ? { id } : {}),
		category: 'clarify',
		body: 'b',
		marker: { start, end: start + 10 },
	} as Comment;
}

function setup(opts: { inPopout: boolean; comments: Comment[] }) {
	const rootSplit = {};
	const popoutSplit = {};
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: { path: PATH },
	}) as MarkdownView;
	const leaf = {
		view,
		getContainer: () => (opts.inPopout ? popoutSplit : rootSplit),
	};
	// Only `get` is read on this path.
	const index = {
		get: (p: string) =>
			p === PATH ? { comments: opts.comments } : undefined,
	};
	const calls = {
		tab: [] as unknown[][],
		hub: 0,
		highlight: [] as unknown[][],
	};
	const plugin = Object.create(
		AnnotecaPlugin.prototype,
	) as unknown as PluginUnderTest;
	Object.assign(plugin, {
		commentIndex: index,
		events: { trigger: () => undefined },
		app: {
			vault: { getAbstractFileByPath: () => null },
			workspace: {
				rootSplit,
				getMostRecentLeaf: () => leaf,
				getActiveFile: () => null,
			},
		},
		openCommentInTab: (...args: unknown[]) => calls.tab.push(args),
		activateView: () => {
			calls.hub += 1;
			return Promise.resolve();
		},
		highlightActiveComment: (...args: unknown[]) =>
			calls.highlight.push(args),
		captureEditorScrollForPath: () => () => undefined,
	});
	return { plugin, leaf, calls };
}

beforeEach(() => {
	noticeLog.length = 0;
});

describe('openReviewerOnComment from a pop-out note', () => {
	it('opens the comment in its own tab beside the pop-out note', () => {
		const c = comment('aaaaaaaa', 5);
		const { plugin, leaf, calls } = setup({
			inPopout: true,
			comments: [c],
		});
		plugin.openReviewerOnComment(c, PATH);
		expect(calls.tab).toEqual([[PATH, c, leaf]]);
		expect(calls.highlight).toEqual([[PATH, 5]]);
		expect(calls.hub).toBe(0);
		expect(noticeLog).toEqual([]);
	});

	it('shows a notice, not the main window hub, for a comment with no id', () => {
		const c = comment(undefined, 5);
		const { plugin, calls } = setup({ inPopout: true, comments: [c] });
		plugin.openReviewerOnComment(c, PATH);
		expect(calls.tab).toEqual([]);
		expect(calls.hub).toBe(0);
		expect(noticeLog).toHaveLength(1);
		expect(noticeLog[0]).toMatch(/no unique ID/);
	});

	it('treats a duplicated id like no id', () => {
		const c = comment('aaaaaaaa', 5);
		const twin = comment('aaaaaaaa', 40);
		const { plugin, calls } = setup({
			inPopout: true,
			comments: [c, twin],
		});
		plugin.openReviewerOnComment(c, PATH);
		expect(calls.tab).toEqual([]);
		expect(calls.hub).toBe(0);
		expect(noticeLog).toHaveLength(1);
	});

	it('opens the hub as before for a note in the main window', () => {
		const c = comment('aaaaaaaa', 5);
		const { plugin, calls } = setup({ inPopout: false, comments: [c] });
		plugin.openReviewerOnComment(c, PATH);
		expect(calls.tab).toEqual([]);
		expect(calls.hub).toBe(1);
		expect(noticeLog).toEqual([]);
	});
});
