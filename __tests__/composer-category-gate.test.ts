// m8: the composer refused to save a comment whose category the settings no
// longer offer, with "Selected category is not enabled." and no way out.
//
// Three routes in, all of them ordinary UI rather than hand-edited state:
//
//  1. Enable the index-entry preset, file a comment under it, turn the preset
//     back off, then edit that comment.
//  2. File a comment under "Tone", then Settings > Remove category on "Tone",
//     which is allowed whenever it is not the default, then edit that comment.
//  3. A categories list without `uncategorized`, which a hand edit or a sync
//     can produce, which dead-ends every scratchpad capture.
//
// The gate is the only place that did not tolerate an unknown category: every
// DISPLAY surface already goes through getCategoryOrFallback. Editing a
// comment's TEXT should never depend on how it is filed.
//
// Same string-backed Editor stub as composer.test.ts, and for the same reason:
// the defect is in the submit path, and `render` needs Obsidian's Setting
// widget, which the mock deliberately does not carry.

import { noticeLog } from '../__mocks__/obsidian';
import type { Editor, EditorPosition, MarkdownFileInfo } from 'obsidian';
import type AnnotecaPlugin from '../main';
import { ComposerForm, type ComposerRequest } from '../composer';
import { parseAll, serialize } from '../parser';
import { DEFAULT_SETTINGS } from '../settings';
import type { AnnotecaSettings, Comment } from '../types';

beforeEach(() => {
	noticeLog.length = 0;
});

function makeEditor(initial: string, path = 'note.md') {
	let content = initial;
	const posToOffset = (pos: EditorPosition): number => {
		const lines = content.split('\n');
		let offset = 0;
		for (let i = 0; i < pos.line && i < lines.length; i++)
			offset += (lines[i]?.length ?? 0) + 1;
		return offset + pos.ch;
	};
	const offsetToPos = (offset: number): EditorPosition => {
		const before = content.slice(0, offset).split('\n');
		const line = before.length - 1;
		return { line, ch: before[line]?.length ?? 0 };
	};
	const editor = {
		getValue: () => content,
		getSelection: () => '',
		getCursor: () => offsetToPos(0),
		posToOffset,
		offsetToPos,
		replaceRange: (
			insert: string,
			from: EditorPosition,
			to?: EditorPosition,
		) => {
			const start = posToOffset(from);
			const end = to === undefined ? start : posToOffset(to);
			content = content.slice(0, start) + insert + content.slice(end);
		},
	};
	return {
		editor: editor as unknown as Editor,
		view: { file: { path } } as unknown as MarkdownFileInfo,
		get content() {
			return content;
		},
	};
}

interface ComposerInternals {
	state: { selectedCategory: string; body: string };
	submit(): Promise<void>;
}

function plugin(settings: Partial<AnnotecaSettings>): AnnotecaPlugin {
	return {
		settings: { ...DEFAULT_SETTINGS, ...settings },
		commentIndex: { hasId: () => false },
	} as unknown as AnnotecaPlugin;
}

function openEdit(
	host: ReturnType<typeof makeEditor>,
	comment: Comment,
	settings: Partial<AnnotecaSettings>,
): ComposerInternals {
	const from = host.editor.offsetToPos(comment.marker.start);
	const to = host.editor.offsetToPos(comment.marker.end);
	const request: ComposerRequest = {
		editor: host.editor,
		view: host.view,
		filePath: 'note.md',
		editing: { comment, from, to },
	};
	return new ComposerForm(plugin(settings), request, {
		close: () => undefined,
	}) as unknown as ComposerInternals;
}

// Categories with `tone` removed, which the settings UI allows whenever it is
// not the default.
const WITHOUT_TONE = DEFAULT_SETTINGS.categories.filter((c) => c.id !== 'tone');

const noteWith = (category: string, body: string) =>
	`Prose. ${serialize({ id: 'aaaaaaaa', category, body })} tail.`;

const commentIn = (text: string): Comment => parseAll(text)[0]!;

describe('m8: editing a comment whose category is no longer offered', () => {
	it('saves, keeping the original category, when the category was removed', async () => {
		const text = noteWith('tone', 'the old wording');
		const host = makeEditor(text);
		const form = openEdit(host, commentIn(text), {
			categories: WITHOUT_TONE,
			defaultCategory: 'clarify',
		});
		form.state.body = 'the new wording';

		await form.submit();

		expect(noticeLog).not.toContain('Selected category is not enabled.');
		const after = commentIn(host.content);
		expect(after.body).toBe('the new wording');
		// Editing the TEXT must not reclassify the comment.
		expect(after.category).toBe('tone');
	});

	it('saves when the preset that supplied the category was switched off', async () => {
		const text = noteWith('index-entry', 'see also: bees');
		const host = makeEditor(text);
		const form = openEdit(host, commentIn(text), {
			enableIndexEntryPreset: false,
			defaultCategory: 'clarify',
		});
		form.state.body = 'see also: wasps';

		await form.submit();

		expect(noticeLog).not.toContain('Selected category is not enabled.');
		const after = commentIn(host.content);
		expect(after.body).toBe('see also: wasps');
		expect(after.category).toBe('index-entry');
	});

	it('saves a scratchpad capture when the list has lost uncategorized', async () => {
		const host = makeEditor('Prose here.');
		const request: ComposerRequest = {
			editor: host.editor,
			view: host.view,
			filePath: 'note.md',
			scratchpad: true,
		};
		const form = new ComposerForm(
			plugin({
				categories: DEFAULT_SETTINGS.categories.filter(
					(c) => c.id !== 'uncategorized',
				),
			}),
			request,
			{ close: () => undefined },
		) as unknown as ComposerInternals;
		form.state.body = 'capture this now, file it later';

		await form.submit();

		expect(noticeLog).not.toContain('Selected category is not enabled.');
		expect(commentIn(host.content).category).toBe('uncategorized');
	});

	it('saves after the scratchpad TOGGLE, where uncategorized is not what the form opened with', async () => {
		// The toggle path, which the constructor path does not cover: the form
		// opened on the default category, so `uncategorized` arrives later and
		// is not `initialCategory`. A mutation check found this was the only
		// thing separating the two allowances.
		const host = makeEditor('Prose here.');
		const request: ComposerRequest = {
			editor: host.editor,
			view: host.view,
			filePath: 'note.md',
		};
		const form = new ComposerForm(
			plugin({
				categories: DEFAULT_SETTINGS.categories.filter(
					(c) => c.id !== 'uncategorized',
				),
				defaultCategory: 'clarify',
			}),
			request,
			{ close: () => undefined },
		) as unknown as ComposerInternals;
		form.state.body = 'file it later';
		// Exactly what the Scratchpad toggle's onChange does.
		form.state.selectedCategory = 'uncategorized';

		await form.submit();

		expect(noticeLog).not.toContain('Selected category is not enabled.');
		expect(commentIn(host.content).category).toBe('uncategorized');
	});

	it('still refuses a NEW comment under a category disabled while the form was open', async () => {
		// The grandfather clause is for an existing comment, not for the
		// default a create form happened to open with. Settings can remove or
		// disable that category while the form sits open, and letting the save
		// through would create the very thing this gate exists to stop: a
		// marker filed under a category that is not offered.
		const host = makeEditor('Prose here.');
		const request: ComposerRequest = {
			editor: host.editor,
			view: host.view,
			filePath: 'note.md',
		};
		const form = new ComposerForm(
			// defaultCategory is 'tone', and 'tone' is no longer in the list.
			plugin({ categories: WITHOUT_TONE, defaultCategory: 'tone' }),
			request,
			{ close: () => undefined },
		) as unknown as ComposerInternals;
		form.state.body = 'a brand new comment';

		await form.submit();

		expect(noticeLog).toContain('Selected category is not enabled.');
		expect(host.content).toBe('Prose here.');
	});

	it('still refuses a category that was never the comment’s own', async () => {
		// The control. Without it, "saves anyway" could just mean the gate is
		// gone, and a new comment filed under a category that does not exist
		// is a marker nothing can find again.
		const text = noteWith('tone', 'the old wording');
		const host = makeEditor(text);
		const form = openEdit(host, commentIn(text), {
			categories: WITHOUT_TONE,
			defaultCategory: 'clarify',
		});
		form.state.body = 'the new wording';
		// What the dropdown could never offer, so only a bad state reaches it.
		form.state.selectedCategory = 'not-a-real-category';

		await form.submit();

		expect(noticeLog).toContain('Selected category is not enabled.');
		expect(host.content).toBe(text);
	});
});
