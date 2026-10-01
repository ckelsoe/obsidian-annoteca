// #84: creating a comment on a selection writes an opening marker at the
// selection's start AND a closer straight after its last character, in one
// editor transaction so a single undo removes the comment whole.
//
// A string-backed Editor stub, like composer.test.ts, extended with the two
// things this path uses that the other stub does not need: a real selection
// (`getCursor('from' | 'to')`) and `transaction`, applied the way CodeMirror
// applies a change set, every change in the coordinates of the document before
// any of them lands.

import { noticeLog } from '../__mocks__/obsidian';
import type {
	Editor,
	EditorPosition,
	EditorTransaction,
	MarkdownFileInfo,
} from 'obsidian';
import type AnnotecaPlugin from '../main';
import { ComposerForm, type ComposerRequest } from '../composer';
import { parseAll, serializeCloser } from '../parser';
import { parseDocument } from '../document';
import { rangeSpan } from '../view-utils';
import { DEFAULT_SETTINGS } from '../settings';
import { CLOSER_REFUSED_MESSAGE } from '../range-placement';
import type { Comment, StorageMode } from '../types';

interface ComposerInternals {
	state: { selectedCategory: string; body: string };
	submit(): Promise<void>;
}

function makeHost(initial: string, from: number, to: number) {
	let content = initial;
	let transactions = 0;
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
		getSelection: () => content.slice(from, to),
		getCursor: (which?: string) => offsetToPos(which === 'to' ? to : from),
		posToOffset,
		offsetToPos,
		replaceRange: (
			insert: string,
			a: EditorPosition,
			b?: EditorPosition,
		) => {
			const start = posToOffset(a);
			const end = b === undefined ? start : posToOffset(b);
			content = content.slice(0, start) + insert + content.slice(end);
		},
		transaction: (tx: EditorTransaction) => {
			transactions += 1;
			const changes = (tx.changes ?? [])
				.map((c) => ({
					at: posToOffset(c.from),
					end: c.to ? posToOffset(c.to) : posToOffset(c.from),
					text: c.text,
				}))
				.sort((x, y) => y.at - x.at);
			for (const c of changes)
				content =
					content.slice(0, c.at) + c.text + content.slice(c.end);
		},
	};
	const view = { file: { path: 'note.md' } };
	return {
		editor: editor as unknown as Editor,
		view: view as unknown as MarkdownFileInfo,
		get content() {
			return content;
		},
		get transactions() {
			return transactions;
		},
	};
}

async function create(
	host: ReturnType<typeof makeHost>,
	storageMode: StorageMode = 'inline',
): Promise<void> {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, storageMode },
		commentIndex: { hasId: () => false },
		app: { metadataCache: { getFileCache: () => null } },
	} as unknown as AnnotecaPlugin;
	const request: ComposerRequest = {
		editor: host.editor,
		view: host.view,
		filePath: 'note.md',
	};
	const form = new ComposerForm(plugin, request, {
		close: () => undefined,
	}) as unknown as ComposerInternals;
	form.state.selectedCategory = 'clarify';
	form.state.body = 'too vague';
	await form.submit();
}

const covered = (doc: string, c: Comment): string | null => {
	const span = rangeSpan(c, (p) => doc.charAt(p));
	return span ? doc.slice(span.from, span.to) : null;
};

beforeEach(() => {
	noticeLog.length = 0;
});

describe('#84: a comment on a selection covers exactly the selection', () => {
	it('writes both markers in one transaction', async () => {
		const doc = 'Before. The vague clause here. After.';
		const from = doc.indexOf('The vague');
		const to = doc.indexOf(' After');
		const host = makeHost(doc, from, to);
		await create(host);
		expect(host.transactions).toBe(1);
		const [c] = parseAll(host.content);
		if (!c) throw new Error('no comment');
		expect(c.id).toBeDefined();
		expect(host.content).toContain(
			`The vague clause here.${serializeCloser(c.id ?? '')} After.`,
		);
		expect(covered(host.content, c)).toBe('The vague clause here.');
	});

	it('spans paragraphs and leaves trailing line breaks outside', async () => {
		const doc = 'Para one.\n\nPara two.\n\nPara three.';
		const host = makeHost(doc, 0, doc.indexOf('Para three'));
		await create(host);
		const [c] = parseAll(host.content);
		if (!c) throw new Error('no comment');
		expect(covered(host.content, c)).toBe('Para one.\n\nPara two.');
	});

	it('in end-of-file storage, the lean marker gets the closer', async () => {
		const doc = 'Alpha beta gamma.';
		const host = makeHost(doc, 6, 10);
		await create(host, 'eof');
		const [c] = parseDocument(host.content).comments;
		if (!c) throw new Error('no comment');
		expect(c.body).toBe('too vague');
		expect(covered(host.content, c)).toBe('beta');
	});

	it('an end inside a code block writes the start only, and says why', async () => {
		const doc = 'Intro text.\n\n```\ncode line\n```\n';
		const host = makeHost(doc, 0, doc.indexOf('line'));
		await create(host);
		const [c] = parseAll(host.content);
		if (!c) throw new Error('no comment');
		expect(c.closer).toBeUndefined();
		expect(host.content).not.toContain('/annoteca');
		expect(noticeLog).toContain(CLOSER_REFUSED_MESSAGE);
	});

	it('a comment at the cursor has no closer', async () => {
		const doc = 'Just prose.';
		const host = makeHost(doc, 5, 5);
		await create(host);
		expect(host.content).not.toContain('/annoteca');
		expect(host.transactions).toBe(0);
	});
});
