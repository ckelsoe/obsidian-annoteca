// The composer's EDIT path, which writes to the document directly rather than
// through CommentService, so none of the service's freshness work covered it.
//
// Both of its inputs were captured when the form opened and were stale by the
// time Save was pressed: the comment SNAPSHOT (which also omitted `addressed`
// entirely) and the editor RANGE. The default composer location is the side
// panel, where the editor stays live behind the form, so "the document changed
// while the form was open" is the ordinary case rather than an unlikely one.
//
// Driven through a string-backed Editor stub, the same way the 2026-08-04 review
// drove it. `state` and `submit` are private, and are reached through a cast
// rather than by rendering: `render` needs Obsidian's DOM extensions
// (createEl/empty) and its Setting widget, neither of which exists under jsdom,
// and the defect is in the submit path, not the form.

import { noticeLog } from '../__mocks__/obsidian';
import type { Editor, EditorPosition } from 'obsidian';
import type AnnotecaPlugin from '../main';
import { ComposerForm, type ComposerRequest } from '../composer';
import { parseAll, serialize } from '../parser';
import { DEFAULT_SETTINGS } from '../settings';
import type { Comment } from '../types';

beforeEach(() => {
	noticeLog.length = 0;
});

// Positions are (line, ch); offsets are absolute. The stub implements the pair
// honestly, because the whole point of the range defect is that a line/column
// pair keeps pointing at the same LINE while the marker moves to another one.
function makeEditor(initial: string) {
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
		get content() {
			return content;
		},
		set content(updated: string) {
			content = updated;
		},
	};
}

interface ComposerInternals {
	state: { selectedCategory: string; body: string };
	submit(): Promise<void>;
}

function makePlugin(): AnnotecaPlugin {
	return {
		settings: { ...DEFAULT_SETTINGS },
		commentIndex: { hasId: () => false },
	} as unknown as AnnotecaPlugin;
}

function openEditor(
	host: ReturnType<typeof makeEditor>,
	comment: Comment,
): { form: ComposerInternals; closed: () => boolean; submitted: () => number } {
	const from = host.editor.offsetToPos(comment.marker.start);
	const to = host.editor.offsetToPos(comment.marker.end);
	let closed = false;
	let submittedAt = -1;
	const request: ComposerRequest = {
		editor: host.editor,
		filePath: 'note.md',
		editing: { comment, from, to },
	};
	const form = new ComposerForm(makePlugin(), request, {
		close: () => {
			closed = true;
		},
		onSubmitted: (_path, markerStart) => {
			submittedAt = markerStart;
		},
	});
	return {
		form: form as unknown as ComposerInternals,
		closed: () => closed,
		submitted: () => submittedAt,
	};
}

function only(content: string): Comment {
	const parsed = parseAll(content);
	expect(parsed).toHaveLength(1);
	const c = parsed[0];
	if (!c) throw new Error('no comment parsed');
	return c;
}

const ADDRESSED_NOTE = [
	'Some prose before.',
	'',
	serialize({
		id: 'edit0001',
		category: 'clarify',
		body: 'the original body',
		date: '2026-08-01T10:00:00',
		author: 'charles',
		replies: [
			{ author: 'ai', date: '2026-08-01T10:05:00', body: 'a reply' },
		],
		addressed: {
			author: 'ai',
			date: '2026-08-01T10:07:00',
			note: 'applied',
			original: 'the prose as it was before the edit',
		},
	}),
	'',
	'Some prose after.',
].join('\n');

describe('composer edit: the addressed state survives', () => {
	it('changes only the body, keeping addressed, the fence and the reply', async () => {
		const host = makeEditor(ADDRESSED_NOTE);
		const { form, closed } = openEditor(host, only(host.content));

		form.state.body = 'the edited body';
		await form.submit();

		expect(closed()).toBe(true);
		const after = only(host.content);
		expect(after.body).toBe('the edited body');
		// Before the fix the edit branch rebuilt the marker field by field and
		// omitted `addressed`, so the [addressed ...] line and its fence both
		// vanished: Reject degraded to Revise and the pre-edit prose was gone
		// from the vault with no other copy in the file.
		expect(after.addressed).toBeDefined();
		expect(after.addressed?.original).toBe(
			'the prose as it was before the edit',
		);
		expect(after.replies).toHaveLength(1);
		expect(after.replies[0]?.body).toBe('a reply');
		expect(after.id).toBe('edit0001');
		expect(host.content.startsWith('Some prose before.')).toBe(true);
		expect(host.content.endsWith('Some prose after.')).toBe(true);
	});
});

describe('composer edit: the write lands on the marker, not on a remembered range', () => {
	it('rewrites the right span after the document changes above it', async () => {
		const host = makeEditor(ADDRESSED_NOTE);
		const { form } = openEditor(host, only(host.content));

		// Twenty characters land at the top of the note while the form is open:
		// another pane, a sync, or the user typing in a split. The remembered
		// EditorPosition still says line 2, which is now different text.
		const inserted = 'INSERTED ABOVE!!!!!\n';
		host.content = inserted + host.content;

		form.state.body = 'the edited body';
		await form.submit();

		const after = only(host.content);
		expect(after.body).toBe('the edited body');
		expect(host.content.startsWith(inserted)).toBe(true);
		expect(host.content).toContain('Some prose before.');
		expect(host.content).toContain('Some prose after.');
		// Nothing outside the marker moved.
		expect(host.content).toBe(
			inserted +
				ADDRESSED_NOTE.replace('the original body', 'the edited body'),
		);
	});

	it('keeps a reply that arrived while the form was open', async () => {
		const host = makeEditor(ADDRESSED_NOTE);
		const { form } = openEditor(host, only(host.content));

		const current = only(host.content);
		const withReply = serialize({
			id: current.id,
			category: current.category,
			body: current.body,
			date: current.date,
			author: current.author,
			anchor: current.anchor,
			replies: [
				...current.replies,
				{
					author: 'charles',
					date: '2026-08-01T10:09:00',
					body: 'landed while the form was open',
				},
			],
			addressed: current.addressed,
			resolution: current.resolution,
		});
		host.content =
			host.content.slice(0, current.marker.start) +
			withReply +
			host.content.slice(current.marker.end);

		form.state.body = 'the edited body';
		await form.submit();

		const after = only(host.content);
		expect(after.replies).toHaveLength(2);
		expect(after.replies[1]?.body).toBe('landed while the form was open');
		expect(after.body).toBe('the edited body');
	});
});

describe('composer edit: a vanished marker refuses instead of writing', () => {
	it('leaves the document alone, warns, and keeps the form open', async () => {
		const host = makeEditor(ADDRESSED_NOTE);
		const { form, closed, submitted } = openEditor(
			host,
			only(host.content),
		);

		const current = only(host.content);
		host.content =
			host.content.slice(0, current.marker.start) +
			host.content.slice(current.marker.end);
		const before = host.content;

		form.state.body = 'the edited body';
		await form.submit();

		expect(host.content).toBe(before);
		expect(noticeLog.join('\n')).toContain('moved or been deleted');
		// The form stays open, because the body field holds text the user just
		// typed and closing on a refusal would destroy it.
		expect(closed()).toBe(false);
		expect(submitted()).toBe(-1);
	});

	it('refuses when two markers share the edited id', async () => {
		const host = makeEditor(ADDRESSED_NOTE);
		const { form, closed } = openEditor(host, only(host.content));

		const current = only(host.content);
		const copy = host.content.slice(
			current.marker.start,
			current.marker.end,
		);
		host.content = `${host.content}\n\n${copy}`;
		const before = host.content;

		form.state.body = 'the edited body';
		await form.submit();

		expect(host.content).toBe(before);
		expect(noticeLog.join('\n')).toContain('identifier edit0001');
		expect(closed()).toBe(false);
	});
});
