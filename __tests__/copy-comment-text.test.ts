// The plugin's copy actions: what lands on the clipboard, what the user is
// told, and that a refused write is reported instead of escaping as an
// unhandled rejection (every caller fires and forgets).

import { noticeLog } from '../__mocks__/obsidian';
import AnnotecaPlugin from '../main';
import { DEFAULT_SETTINGS } from '../settings';
import type { ClipboardWindow } from '../comment-text';
import type { Comment } from '../types';

interface PluginUnderTest {
	settings: typeof DEFAULT_SETTINGS;
	copyCommentText(c: Comment, win: ClipboardWindow): Promise<void>;
	copyCommentsText(
		groups: { path: string; comments: Comment[] }[],
		win: ClipboardWindow,
	): Promise<void>;
}

const comment = (body: string): Comment => ({
	id: 'aaaaaaaa',
	category: 'clarify',
	body,
	date: undefined,
	author: undefined,
	anchor: undefined,
	replies: [],
	addressed: undefined,
	resolution: undefined,
	unknownLines: [],
	marker: { start: 0, end: 1 },
	source: undefined,
});

let written: string[];
let refuse: boolean;

// The window a copy is asked for from. Only its clipboard is read.
const win: ClipboardWindow = {
	navigator: {
		clipboard: {
			writeText: (text: string) => {
				if (refuse) return Promise.reject(new Error('denied'));
				written.push(text);
				return Promise.resolve();
			},
		},
	},
};

beforeEach(() => {
	written = [];
	refuse = false;
	noticeLog.length = 0;
});

const plugin = (): PluginUnderTest => {
	const p = Object.create(
		AnnotecaPlugin.prototype,
	) as unknown as PluginUnderTest;
	p.settings = { ...DEFAULT_SETTINGS };
	return p;
};

describe('copyCommentText', () => {
	it('copies the thread with the category display name', async () => {
		await plugin().copyCommentText(comment('hello'), win);
		expect(written).toEqual(['**Clarify**\n\nhello']);
		expect(noticeLog).toEqual(['Copied comment text.']);
	});

	it('reports a refused clipboard write instead of rejecting', async () => {
		refuse = true;
		const error = jest.spyOn(console, 'error').mockImplementation(() => {});
		await expect(
			plugin().copyCommentText(comment('hello'), win),
		).resolves.toBeUndefined();
		expect(noticeLog).toEqual(['Could not copy to the clipboard.']);
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});

describe('copyCommentsText', () => {
	it('copies every comment and says how many', async () => {
		await plugin().copyCommentsText(
			[{ path: 'a.md', comments: [comment('one'), comment('two')] }],
			win,
		);
		expect(written).toHaveLength(1);
		expect(noticeLog).toEqual(['Copied 2 comments.']);
	});

	it('writes nothing when there is nothing to copy', async () => {
		await plugin().copyCommentsText([{ path: 'a.md', comments: [] }], win);
		expect(written).toEqual([]);
		expect(noticeLog).toEqual(['No comments to copy.']);
	});

	it('reports a refused clipboard write instead of rejecting', async () => {
		refuse = true;
		const error = jest.spyOn(console, 'error').mockImplementation(() => {});
		await expect(
			plugin().copyCommentsText(
				[{ path: 'a.md', comments: [comment('one')] }],
				win,
			),
		).resolves.toBeUndefined();
		expect(noticeLog).toEqual(['Could not copy to the clipboard.']);
		error.mockRestore();
	});
});
