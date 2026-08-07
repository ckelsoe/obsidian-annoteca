/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><div></div><span></span><button></button><textarea></textarea><select><option></option></select></div></body></html>"}
 */
// Three things that decide whether an unsent reply survives.
//
// M8: dismissTapPopoverOnOutsideClick captured `view.dom.ownerDocument` in its
// constructor and had no update(), so the sole outside-dismiss path stayed
// nailed to the window the view was born in. Dragging a tab into a popout left
// the popover undismissable there while a stray mousedown back in the main
// window dismissed it.
//
// M9 limb (b): remapPinnedTooltip resolved the marker by EXACT offset equality
// after mapPos(offset, 1). A change that straddles the marker's start leaves
// the document byte-identical and the marker where it was, but the mapped
// offset lands one past it, so the find missed and the composer was torn down
// with the user's text in it.
//
// M9 limb (a): an id-less comment had no draft key at all, so nothing was ever
// stored for it and there was nothing to restore from. Those comments are what
// "Convert comments" emits, so this is not an exotic shape.

import { EditorState } from '@codemirror/state';
import { EditorView, showTooltip } from '@codemirror/view';

import {
	buildAnnotecaExtension,
	findMarkersInDoc,
	setReplyComposerEffect,
	setTapPopoverEffect,
	type DecorationContext,
} from '../decorations';
import { DEFAULT_SETTINGS } from '../settings';
import type { AnnotecaSettings } from '../types';
import { installObsidianDomHelpers } from '../__mocks__/obsidian';
import { stubDecorationContext } from './stub-context';

// Id-less on purpose: it is the shape the importer emits and the one with no
// identity beyond position.
const IDLESS_DOC =
	'Prose before. <!-- annoteca/clarify: needs a source --> after.';
const IDLESS_MARKER = findMarkersInDoc(IDLESS_DOC)[0]!;
const IDLESS_START = IDLESS_MARKER.marker.start;
// The key the composer builds for a comment with no id: keyed on the comment's
// own text, so it survives the marker moving and cannot be picked up by a
// different comment that lands on the old offset.
const IDLESS_DRAFT_KEY = `idless:notes/a.md\0${IDLESS_MARKER.category}\0${IDLESS_MARKER.body}`;

let settings: AnnotecaSettings;
const views: EditorView[] = [];

// A draft store that actually records, so "was anything saved" is answerable.
function draftRecordingContext(sourcePath: string): {
	ctx: DecorationContext;
	drafts: Map<string, string>;
} {
	const drafts = new Map<string, string>();
	const base = stubDecorationContext(() => settings);
	return {
		drafts,
		ctx: {
			...base,
			getSourcePath: () => sourcePath,
			loadDraft: (k: string) => drafts.get(k) ?? '',
			saveDraft: (k: string, v: string) => {
				drafts.set(k, v);
			},
			clearDraft: (k: string) => {
				drafts.delete(k);
			},
		},
	};
}

function openView(doc: string, ctx: DecorationContext): EditorView {
	const view = new EditorView({
		state: EditorState.create({
			doc,
			extensions: [buildAnnotecaExtension(ctx)],
		}),
		parent: document.body,
	});
	views.push(view);
	return view;
}

function settle(): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, 30);
	});
}

function tooltipCount(view: EditorView): number {
	return view.state.facet(showTooltip).filter(Boolean).length;
}

async function openComposer(
	view: EditorView,
	at: number,
): Promise<HTMLTextAreaElement> {
	await settle();
	view.dispatch({ effects: setReplyComposerEffect.of(at) });
	await settle();
	const textarea = document.querySelector<HTMLTextAreaElement>(
		'.annoteca-reply-composer-textarea',
	);
	if (!textarea) throw new Error('composer did not mount');
	return textarea;
}

beforeAll(() => {
	installObsidianDomHelpers();
	window.activeDocument = document;
	window.activeWindow = window;
});

beforeEach(() => {
	settings = {
		...DEFAULT_SETTINGS,
		indicatorStyle: 'underline',
		markerClickAction: 'popover',
	};
});

afterEach(() => {
	while (views.length > 0) views.pop()?.destroy();
	document.body.replaceChildren();
});

describe('M9: the composer survives a change straddling the marker start', () => {
	it('keeps the composer and its text when the doc is rewritten identically across the boundary', async () => {
		const { ctx } = draftRecordingContext('notes/a.md');
		const view = openView(IDLESS_DOC, ctx);
		const textarea = await openComposer(view, IDLESS_START);
		textarea.value = 'unsent reply';
		textarea.dispatchEvent(new Event('input', { bubbles: true }));

		// Replace the space and the `<` with the identical two characters. The
		// document is byte-identical afterwards and the marker still starts at
		// IDLESS_START, but mapPos(start, 1) lands at start + 1.
		const from = IDLESS_START - 1;
		view.dispatch({
			changes: {
				from,
				to: from + 2,
				insert: IDLESS_DOC.slice(from, from + 2),
			},
		});
		await settle();

		expect(view.state.doc.toString()).toBe(IDLESS_DOC);
		expect(tooltipCount(view)).toBe(1);
		const after = document.querySelector<HTMLTextAreaElement>(
			'.annoteca-reply-composer-textarea',
		);
		expect(after).toBe(textarea);
		expect(after?.value).toBe('unsent reply');
	});

	it('refuses when the id-less comment’s own text changed underneath it', async () => {
		// Why containment is not enough on its own. A mutation check found
		// this file could not tell the tie apart from bare containment, and
		// this is the case that decides it.
		//
		// One transaction does two things: a straddle across the marker start
		// (so the exact-offset match misses and containment is what answers),
		// and an edit to the BODY. An id-less comment has no identity beyond
		// its position and its own text, which is exactly what the edit path
		// already requires of it. Without the tie the composer stays open
		// pointing at a comment whose text is no longer the one it opened on,
		// and Send posts the reply to it.
		const { ctx } = draftRecordingContext('notes/a.md');
		const view = openView(IDLESS_DOC, ctx);
		const textarea = await openComposer(view, IDLESS_START);
		textarea.value = 'unsent reply';
		textarea.dispatchEvent(new Event('input', { bubbles: true }));

		const bodyAt = IDLESS_DOC.indexOf('needs a source');
		view.dispatch({
			changes: [
				// Straddle: same two characters back again.
				{
					from: IDLESS_START - 1,
					to: IDLESS_START + 1,
					insert: IDLESS_DOC.slice(
						IDLESS_START - 1,
						IDLESS_START + 1,
					),
				},
				// The body is now a different body.
				{
					from: bodyAt,
					to: bodyAt + 'needs a source'.length,
					insert: 'rewritten by another pane',
				},
			],
		});
		await settle();

		// The premise: still exactly one marker, at the same offset, with a
		// different body. So containment alone would have matched it.
		const now = findMarkersInDoc(view.state.doc.toString());
		expect(now).toHaveLength(1);
		expect(now[0]!.marker.start).toBe(IDLESS_START);
		expect(now[0]!.body).toBe('rewritten by another pane');

		expect(tooltipCount(view)).toBe(0);
	});

	it('still drops the composer when the marker is genuinely deleted', async () => {
		// The control. Without it, "survives" could just mean "never dismisses".
		const { ctx } = draftRecordingContext('notes/a.md');
		const view = openView(IDLESS_DOC, ctx);
		await openComposer(view, IDLESS_START);

		const marker = findMarkersInDoc(IDLESS_DOC)[0]!;
		view.dispatch({
			changes: {
				from: marker.marker.start,
				to: marker.marker.end,
				insert: '',
			},
		});
		await settle();

		expect(tooltipCount(view)).toBe(0);
	});
});

describe('M9: an id-less comment gets a draft', () => {
	it('records typed text under a key built from the comment’s own text', async () => {
		const { ctx, drafts } = draftRecordingContext('notes/a.md');
		const view = openView(IDLESS_DOC, ctx);
		const textarea = await openComposer(view, IDLESS_START);

		textarea.value = 'twenty-two characters!';
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		// Past the 300ms debounce.
		await new Promise((r) => window.setTimeout(r, 400));

		expect([...drafts.entries()]).toEqual([
			[IDLESS_DRAFT_KEY, 'twenty-two characters!'],
		]);
	});

	it('restores that draft when the composer is reopened', async () => {
		const { ctx, drafts } = draftRecordingContext('notes/a.md');
		drafts.set(IDLESS_DRAFT_KEY, 'from an earlier session');
		const view = openView(IDLESS_DOC, ctx);

		const textarea = await openComposer(view, IDLESS_START);

		expect(textarea.value).toBe('from an earlier session');
	});

	it('keeps the draft with the comment when the note is edited above it', async () => {
		// Why the key is not the offset. Cancel deliberately keeps the draft,
		// so the note can move underneath it before the composer is reopened.
		// A positional key would strand the draft at an offset the comment has
		// left, and hand it to whatever moved onto that offset instead.
		const { ctx, drafts } = draftRecordingContext('notes/a.md');
		const view = openView(IDLESS_DOC, ctx);
		const textarea = await openComposer(view, IDLESS_START);
		textarea.value = 'unsent reply';
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => window.setTimeout(r, 400));

		view.dispatch({ changes: { from: 0, to: 0, insert: 'PREFIX ' } });
		await settle();
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => window.setTimeout(r, 400));

		// The marker moved, and the draft is still under the one key.
		const moved = findMarkersInDoc(view.state.doc.toString())[0]!;
		expect(moved.marker.start).not.toBe(IDLESS_START);
		expect([...drafts.entries()]).toEqual([
			[IDLESS_DRAFT_KEY, 'unsent reply'],
		]);
	});

	it('does not hand a draft to a different comment', async () => {
		// The other half: a comment whose text differs must not read this one's
		// draft, whatever offset it sits at.
		const other =
			'Prose before. <!-- annoteca/clarify: a different comment --> after.';
		const { ctx, drafts } = draftRecordingContext('notes/a.md');
		drafts.set(IDLESS_DRAFT_KEY, 'meant for the other comment');
		const view = openView(other, ctx);

		const textarea = await openComposer(
			view,
			findMarkersInDoc(other)[0]!.marker.start,
		);

		expect(textarea.value).toBe('');
	});

	it('stores nothing when the editor cannot say which file it holds', async () => {
		// A positional key is meaningless without the path half, and inventing
		// one would let two notes share a draft.
		const { ctx, drafts } = draftRecordingContext('');
		const view = openView(IDLESS_DOC, ctx);
		const textarea = await openComposer(view, IDLESS_START);

		textarea.value = 'nowhere to put this';
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => window.setTimeout(r, 400));

		expect([...drafts.keys()]).toEqual([]);
	});
});

describe('M8: the outside-click listener follows its window', () => {
	it('re-binds to the new document when the view moves', async () => {
		const { ctx } = draftRecordingContext('notes/a.md');
		const view = openView(IDLESS_DOC, ctx);
		await settle();
		view.dispatch({ effects: setTapPopoverEffect.of(IDLESS_START) });
		await settle();
		expect(tooltipCount(view)).toBe(1);

		// What Obsidian does when a tab is dragged out: the view's DOM ends up
		// in another document. A popout is a separate jsdom Document here,
		// which is the same realm crossing the production code faces.
		const popout = document.implementation.createHTMLDocument('popout');
		popout.body.appendChild(popout.importNode(view.dom, true));
		Object.defineProperty(view.dom, 'ownerDocument', {
			value: popout,
			configurable: true,
		});
		// Any transaction is enough: update() is where the re-bind happens.
		//
		// Stated rather than hidden: dispatching here stands in for the update
		// Obsidian's own move produces, and the re-bind inherits that
		// dependency from perWindowTooltipHost, which re-parents on update()
		// for the same reason. A move that produced no update at all would
		// leave both the host and this listener on the old document, so the
		// popover would already be in the wrong window. This asserts the
		// re-bind, not the trigger.
		view.dispatch({ changes: { from: 0, to: 0, insert: '' } });
		await settle();

		// A mousedown in the POPOUT now dismisses, where before it did nothing.
		// Dispatched on an ELEMENT: the handler calls target.closest, and a
		// Document has no such method, so a document-level dispatch would only
		// ever prove the guard throws.
		popout.body.dispatchEvent(
			new MouseEvent('mousedown', { bubbles: true }),
		);
		await settle();
		expect(tooltipCount(view)).toBe(0);
	});

	it('stops listening to the window it left', async () => {
		const { ctx } = draftRecordingContext('notes/a.md');
		const view = openView(IDLESS_DOC, ctx);
		await settle();
		view.dispatch({ effects: setTapPopoverEffect.of(IDLESS_START) });
		await settle();

		const popout = document.implementation.createHTMLDocument('popout');
		popout.body.appendChild(popout.importNode(view.dom, true));
		Object.defineProperty(view.dom, 'ownerDocument', {
			value: popout,
			configurable: true,
		});
		view.dispatch({ changes: { from: 0, to: 0, insert: '' } });
		await settle();

		// A stray click back in the MAIN window used to kill the popout's
		// popover. It must not any more.
		document.body.dispatchEvent(
			new MouseEvent('mousedown', { bubbles: true }),
		);
		await settle();
		expect(tooltipCount(view)).toBe(1);
	});

	it('still dismisses in the window it was born in', async () => {
		// Control: the re-bind must not cost the ordinary case.
		const { ctx } = draftRecordingContext('notes/a.md');
		const view = openView(IDLESS_DOC, ctx);
		await settle();
		view.dispatch({ effects: setTapPopoverEffect.of(IDLESS_START) });
		await settle();
		expect(tooltipCount(view)).toBe(1);

		document.body.dispatchEvent(
			new MouseEvent('mousedown', { bubbles: true }),
		);
		await settle();
		expect(tooltipCount(view)).toBe(0);
	});
});
