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
import type { Editor, EditorPosition, MarkdownFileInfo } from 'obsidian';
import type AnnotecaPlugin from '../main';
import { ComposerForm, type ComposerRequest } from '../composer';
import { convertNativeComments } from '../imports';
import { parseAll, serialize, serializeLeanMarker } from '../parser';
import { parseDocument } from '../document';
import { parseStore, writeStoreRegion, type StoredComment } from '../store';
import { DEFAULT_SETTINGS } from '../settings';
import type { Comment } from '../types';

beforeEach(() => {
	noticeLog.length = 0;
});

// Positions are (line, ch); offsets are absolute. The stub implements the pair
// honestly, because the whole point of the range defect is that a line/column
// pair keeps pointing at the same LINE while the marker moves to another one.
// `showing` is the path the host's view reports, and it is settable because
// Obsidian hands the SAME Editor object back after a leaf switches file: the
// buffer changes under it and the view starts naming the other note. That pair
// of moves is the whole of the wrong-file defect.
function makeEditor(initial: string, path = 'note.md') {
	let content = initial;
	let showing: string | null = path;
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
	const view = {
		get file() {
			return showing === null ? null : { path: showing };
		},
	};
	return {
		editor: editor as unknown as Editor,
		view: view as unknown as MarkdownFileInfo,
		get content() {
			return content;
		},
		set content(updated: string) {
			content = updated;
		},
		// Model a tab switching to another note: the buffer swaps and the view
		// names the new file, both under the Editor object the form is holding.
		switchTo(otherPath: string | null, otherContent: string) {
			showing = otherPath;
			content = otherContent;
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
		// The create path reads a per-note annoteca_storage override from the
		// metadata cache; model an empty cache (no override) here.
		app: { metadataCache: { getFileCache: () => null } },
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
		view: host.view,
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

// The create path, which shares `submit` with the edit path and therefore
// shares the editor that decides which document gets written.
function openCreate(host: ReturnType<typeof makeEditor>): {
	form: ComposerInternals;
	closed: () => boolean;
} {
	let closed = false;
	const request: ComposerRequest = {
		editor: host.editor,
		view: host.view,
		filePath: 'note.md',
	};
	const form = new ComposerForm(makePlugin(), request, {
		close: () => {
			closed = true;
		},
	});
	return { form: form as unknown as ComposerInternals, closed: () => closed };
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

// The id-less branch of resolveEditTarget. Every test above uses a marker with an
// id, so only the id branch ran; this is the branch that identifies by position
// and can therefore point at unrelated text.
const IDLESS_NOTE = [
	'Some prose before.',
	'',
	serialize({ category: 'clarify', body: 'the original body' }),
	'',
	'Some prose after.',
].join('\n');

describe('composer edit: markers with no id', () => {
	it('rewrites the marker at the captured offset when nothing moved', async () => {
		const host = makeEditor(IDLESS_NOTE);
		const { form, closed } = openEditor(host, only(host.content));

		form.state.body = 'the edited body';
		await form.submit();

		expect(closed()).toBe(true);
		expect(host.content).toBe(
			IDLESS_NOTE.replace('the original body', 'the edited body'),
		);
	});

	it('refuses when the document changed above it, keeping the form open', async () => {
		const host = makeEditor(IDLESS_NOTE);
		const { form, closed } = openEditor(host, only(host.content));

		const inserted = 'INSERTED ABOVE!!!!!\n';
		host.content = inserted + host.content;
		const before = host.content;

		form.state.body = 'the edited body';
		await form.submit();

		// Nothing in the file carries an identity for an id-less marker beyond
		// its position, so a drifted offset has to refuse rather than guess.
		expect(host.content).toBe(before);
		expect(noticeLog.join('\n')).toContain('moved or been deleted');
		expect(closed()).toBe(false);
	});

	// The document below is the SHIPPED importer's output rather than a
	// hand-built string, because `convert comments` is where id-less markers
	// come from in practice: it emits `serialize({ category, body })` with no id,
	// no date and no author, so a run of them differs only in body. Two bodies of
	// equal length then give two markers of equal extent, and category plus
	// extent plus start offset stops being an identity.
	it('refuses when a whole line is deleted above an imported run of markers', async () => {
		const imported = convertNativeComments(
			[
				'%%fix the wording%%',
				'%%cite the source%%',
				'%%cut this aside.%%',
				'Closing prose.',
			].join('\n'),
			'clarify',
		);
		const host = makeEditor(imported.updated);

		const before = parseAll(host.content);
		// The premise the defect rests on: the importer assigns no ids.
		expect(before.map((c) => c.id)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		const target = before[1];
		if (!target) throw new Error('no second marker');
		const { form, closed } = openEditor(host, target);

		// A plain whole-line delete above, which is the ordinary thing to do
		// while the panel composer is open. It slides marker #3 onto the offset
		// marker #2 was opened at, where the old category and extent guards both
		// passed and Save destroyed "cut this aside." with no notice at all.
		host.content = host.content.slice(host.content.indexOf('\n') + 1);
		const unchanged = host.content;

		form.state.body = 'EDIT MEANT FOR cite the source';
		await form.submit();

		expect(host.content).toBe(unchanged);
		expect(parseAll(host.content).map((c) => c.body)).toEqual([
			'cite the source',
			'cut this aside.',
		]);
		expect(noticeLog.join('\n')).toContain('moved or been deleted');
		expect(closed()).toBe(false);
	});

	// Category, extent and body together are still not an identity. Two markers
	// can agree on all three and differ in a field of the same length, and the
	// rewrite carries the target's author, date and thread forward, so landing on
	// the wrong one attaches the edit to somebody else's comment.
	it('refuses when a marker differing only in equal-length metadata lands on the offset', async () => {
		const twinA = serialize({
			category: 'clarify',
			body: 'note',
			author: 'aa',
		});
		const twinB = serialize({
			category: 'clarify',
			body: 'note',
			author: 'bb',
		});
		// The premise: identical but for two characters of author.
		expect(twinB).toHaveLength(twinA.length);
		expect(twinB).not.toBe(twinA);

		const padding = `${'P'.repeat(twinA.length + 8)}\n`;
		const host = makeEditor(`${padding}${twinA}\n${twinB}\ntail`);
		const [first, second] = parseAll(host.content);
		if (!first || !second) throw new Error('expected two markers');
		const { form, closed } = openEditor(host, first);

		// Delete exactly the distance between the two marker starts, from above
		// both, so the SECOND marker comes to rest on the offset the form
		// remembers.
		const gap = second.marker.start - first.marker.start;
		host.content = host.content.slice(gap);
		expect(parseAll(host.content)[1]?.marker.start).toBe(
			first.marker.start,
		);
		const unchanged = host.content;

		form.state.body = 'EDIT MEANT FOR the first marker';
		await form.submit();

		expect(host.content).toBe(unchanged);
		expect(noticeLog.join('\n')).toContain('moved or been deleted');
		expect(closed()).toBe(false);
	});

	// The fingerprint is read out of the document using the snapshot's offsets,
	// so on its own it can only ever agree with itself. If the snapshot was
	// already stale when the form opened, that self-agreement would accept the
	// marker sitting there instead of the comment the user clicked.
	it('refuses when the snapshot was already stale before the form opened', async () => {
		const wanted = serialize({ category: 'clarify', body: 'wanted' });
		// Same total length, so the extent check cannot be what refuses and the
		// tie back to the clicked card is what has to do the work.
		const other = serialize({ category: 'tone', body: 'other!!!!' });
		expect(other).toHaveLength(wanted.length);

		// The document holds `other` where the Hub card still believes `wanted`
		// is: an edit landed and the index refresh has not caught up.
		const host = makeEditor(`Prose.\n${other}\ntail`);
		const stale = parseAll(`Prose.\n${wanted}\ntail`)[0];
		if (!stale) throw new Error('no snapshot parsed');
		const { form, closed } = openEditor(host, stale);
		const unchanged = host.content;

		form.state.body = 'EDIT MEANT FOR wanted';
		await form.submit();

		expect(host.content).toBe(unchanged);
		expect(noticeLog.join('\n')).toContain('moved or been deleted');
		expect(closed()).toBe(false);
	});

	it('refuses when a different marker of the same category now starts there', async () => {
		const host = makeEditor(IDLESS_NOTE);
		const { form, closed } = openEditor(host, only(host.content));

		// Same category, same start offset, different extent: the end-offset
		// check is the only thing that can tell them apart.
		const current = only(host.content);
		host.content =
			host.content.slice(0, current.marker.start) +
			serialize({
				category: 'clarify',
				body: 'an entirely different comment',
			}) +
			host.content.slice(current.marker.end);
		const before = host.content;

		form.state.body = 'the edited body';
		await form.submit();

		expect(host.content).toBe(before);
		expect(noticeLog.join('\n')).toContain('moved or been deleted');
		expect(closed()).toBe(false);
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

// The tab the composer was opened from can move on to another file while the
// form is open, and the panel composer is BUILT for the editor to stay usable
// behind it. Obsidian hands back the same Editor object across that switch
// (checked live on 1.13.4), so `editor.replaceRange` writes into whichever file
// the tab now shows unless something re-checks at Save time.
describe('composer: the write refuses when the tab moved to another file', () => {
	const OTHER_NOTE = ['Chapter one.', '', 'Tail of the other note.'].join(
		'\n',
	);

	it('refuses to EDIT into the file the tab switched to', async () => {
		const host = makeEditor(ADDRESSED_NOTE);
		const { form, closed, submitted } = openEditor(
			host,
			only(host.content),
		);

		// "Make a copy" is the nastiest shape: identical text, identical marker
		// id, so resolving by id finds a perfectly good target in the wrong file.
		host.switchTo('note copy.md', ADDRESSED_NOTE);

		form.state.body = 'the edited body';
		await form.submit();

		expect(host.content).toBe(ADDRESSED_NOTE);
		expect(noticeLog.join('\n')).toContain('no longer shows note.md');
		expect(closed()).toBe(false);
		expect(submitted()).toBe(-1);
	});

	it('refuses to CREATE into the file the tab switched to', async () => {
		const host = makeEditor(ADDRESSED_NOTE);
		const { form, closed } = openCreate(host);

		host.switchTo('note copy.md', OTHER_NOTE);

		form.state.selectedCategory = 'clarify';
		form.state.body = 'a new comment meant for note.md';
		await form.submit();

		expect(host.content).toBe(OTHER_NOTE);
		expect(noticeLog.join('\n')).toContain('no longer shows note.md');
		expect(closed()).toBe(false);
	});

	it('refuses when the tab is showing no file at all', async () => {
		const host = makeEditor(ADDRESSED_NOTE);
		const { form } = openEditor(host, only(host.content));

		host.switchTo(null, ADDRESSED_NOTE);

		form.state.body = 'the edited body';
		await form.submit();

		expect(host.content).toBe(ADDRESSED_NOTE);
		expect(noticeLog.join('\n')).toContain('no longer shows note.md');
	});

	// The control. Without it the three refusals above would also pass against a
	// composer that refused everything.
	it('still saves when the tab is showing the file it was opened on', async () => {
		const host = makeEditor(ADDRESSED_NOTE);
		const { form, closed } = openEditor(host, only(host.content));

		form.state.body = 'the edited body';
		await form.submit();

		expect(host.content).toContain('the edited body');
		expect(noticeLog).toEqual([]);
		expect(closed()).toBe(true);
	});
});

// The composer's eof-mode path (issue #48). Create inserts a lean category+id
// marker and writes the body/thread to the end-of-file store; edit updates the
// store entry and keeps the marker lean, rather than pulling the body inline.
describe('composer: eof storage mode', () => {
	function eofPlugin(
		storageMode: 'inline' | 'eof',
		frontmatter: Record<string, unknown> = {},
	): AnnotecaPlugin {
		return {
			settings: { ...DEFAULT_SETTINGS, storageMode },
			commentIndex: { hasId: () => false },
			app: {
				metadataCache: { getFileCache: () => ({ frontmatter }) },
			},
		} as unknown as AnnotecaPlugin;
	}

	function openCreateWith(
		host: ReturnType<typeof makeEditor>,
		plugin: AnnotecaPlugin,
	): { form: ComposerInternals; closed: () => boolean } {
		let closed = false;
		const request: ComposerRequest = {
			editor: host.editor,
			view: host.view,
			filePath: 'note.md',
		};
		const form = new ComposerForm(plugin, request, {
			close: () => {
				closed = true;
			},
		});
		return {
			form: form as unknown as ComposerInternals,
			closed: () => closed,
		};
	}

	function openEditWith(
		host: ReturnType<typeof makeEditor>,
		comment: Comment,
		plugin: AnnotecaPlugin,
	): { form: ComposerInternals } {
		const from = host.editor.offsetToPos(comment.marker.start);
		const to = host.editor.offsetToPos(comment.marker.end);
		const request: ComposerRequest = {
			editor: host.editor,
			view: host.view,
			filePath: 'note.md',
			editing: { comment, from, to },
		};
		const form = new ComposerForm(plugin, request, { close: () => {} });
		return { form: form as unknown as ComposerInternals };
	}

	// A one-comment eof note: a lean marker in the prose, its content in the store.
	function eofNote(entry: StoredComment): string {
		const prose = `Prose under review. ${serializeLeanMarker(
			entry.category,
			entry.id,
		)}`;
		return writeStoreRegion(prose, [entry]);
	}

	it('create writes a lean marker plus a store entry, not an inline body', async () => {
		const host = makeEditor('Prose here.');
		const { form, closed } = openCreateWith(host, eofPlugin('eof'));

		form.state.selectedCategory = 'clarify';
		form.state.body = 'which products?';
		await form.submit();

		expect(closed()).toBe(true);
		// The inline marker is lean: parseAll sees an empty body at the passage.
		const markers = parseAll(host.content);
		expect(markers).toHaveLength(1);
		expect(markers[0]?.body).toBe('');
		expect(markers[0]?.category).toBe('clarify');
		// The body lives in the store, and parseDocument merges it back.
		expect(host.content).toContain('annoteca:store');
		const merged = parseDocument(host.content).comments;
		expect(merged).toHaveLength(1);
		expect(merged[0]?.body).toBe('which products?');
		expect(merged[0]?.id).toBe(markers[0]?.id);
	});

	it('edit changes the store body and keeps the marker byte-for-byte lean', async () => {
		const entry: StoredComment = {
			id: 'eofedit0',
			category: 'clarify',
			body: 'first body',
			replies: [
				{ author: 'ai', date: '2026-08-01', body: 'a standing reply' },
			],
		};
		const host = makeEditor(eofNote(entry));
		const lean = serializeLeanMarker('clarify', 'eofedit0');
		const opened = parseDocument(host.content).comments[0];
		if (!opened) throw new Error('no eof comment');
		const { form } = openEditWith(host, opened, eofPlugin('eof'));

		form.state.body = 'second body';
		await form.submit();

		// Marker unchanged; the body moved in the store, not inline.
		expect(host.content).toContain(lean);
		const merged = parseDocument(host.content).comments;
		expect(merged[0]?.body).toBe('second body');
		// The standing reply is preserved through the store rewrite.
		expect(merged[0]?.replies).toHaveLength(1);
		expect(parseAll(host.content)[0]?.body).toBe('');
	});

	it('edit changing the category rewrites the lean marker and the store entry', async () => {
		const entry: StoredComment = {
			id: 'eofcat00',
			category: 'clarify',
			body: 'body stays',
			replies: [],
		};
		const host = makeEditor(eofNote(entry));
		const opened = parseDocument(host.content).comments[0];
		if (!opened) throw new Error('no eof comment');
		const { form } = openEditWith(host, opened, eofPlugin('eof'));

		form.state.selectedCategory = 'tone';
		form.state.body = 'body stays';
		await form.submit();

		// The marker carries the new category (it is authoritative for it).
		expect(host.content).toContain(serializeLeanMarker('tone', 'eofcat00'));
		const merged = parseDocument(host.content).comments;
		expect(merged[0]?.category).toBe('tone');
		expect(merged[0]?.body).toBe('body stays');
		// Still lean, still one comment, still in the store.
		expect(parseAll(host.content)[0]?.body).toBe('');
		expect(parseStore(host.content)).toHaveLength(1);
	});

	it('keeps an inline note inline even when the default is eof (current format wins)', async () => {
		// The note already has an inline comment, so a new comment is stored inline
		// regardless of the global default: one note never mixes styles.
		const inline = serialize({
			id: 'inlnkeep',
			category: 'clarify',
			body: 'existing inline',
		});
		const host = makeEditor(`A. ${inline}\n\nB.`);
		const { form } = openCreateWith(host, eofPlugin('eof'));

		form.state.selectedCategory = 'tone';
		form.state.body = 'new one';
		await form.submit();

		expect(host.content).not.toContain('annoteca:store');
		expect(parseAll(host.content)).toHaveLength(2);
	});

	it('honors a per-note annoteca_storage override on an empty note', async () => {
		// Global default is inline, but this note asks for eof in its frontmatter.
		const host = makeEditor('Just prose.');
		const { form } = openCreateWith(
			host,
			eofPlugin('inline', { annoteca_storage: 'eof' }),
		);

		form.state.selectedCategory = 'clarify';
		form.state.body = 'stored at the bottom';
		await form.submit();

		expect(host.content).toContain('annoteca:store');
		expect(parseAll(host.content)[0]?.body).toBe('');
		expect(parseDocument(host.content).comments[0]?.body).toBe(
			'stored at the bottom',
		);
	});
});
