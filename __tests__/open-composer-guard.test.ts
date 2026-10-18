// "Add comment here" with the cursor inside an existing marker is refused
// before the form opens, so nobody writes a comment only for Save to refuse
// it. The composer checks again at Save (composer.test.ts).

import { noticeLog } from '../__mocks__/obsidian';
import AnnotecaPlugin from '../main';
import { serialize } from '../parser';
import { DEFAULT_SETTINGS } from '../settings';
import type { ComposerRequest } from '../composer';

interface PluginUnderTest {
	settings: typeof DEFAULT_SETTINGS;
	openComposer(request: ComposerRequest): Promise<boolean>;
}

const MARKER = serialize({ id: 'aaaaaaaa', category: 'clarify', body: 'b' });
const NOTE = `Text ${MARKER} more.`;

function request(cursor: number): ComposerRequest {
	const pos = { line: 0, ch: cursor };
	return {
		editor: {
			getValue: () => NOTE,
			getCursor: () => pos,
			posToOffset: (p: { ch: number }) => p.ch,
		},
		view: { file: { path: 'note.md' } },
		filePath: 'note.md',
	} as unknown as ComposerRequest;
}

beforeEach(() => {
	noticeLog.length = 0;
});

it('does not open the form with the cursor inside a marker', async () => {
	const p = Object.create(
		AnnotecaPlugin.prototype,
	) as unknown as PluginUnderTest;
	p.settings = { ...DEFAULT_SETTINGS, composerLocation: 'panel' };
	const opened = await p.openComposer(request(NOTE.indexOf('<!--') + 4));
	expect(opened).toBe(false);
	expect(noticeLog.join('\n')).toContain(
		"can't start inside another comment's marker",
	);
});
