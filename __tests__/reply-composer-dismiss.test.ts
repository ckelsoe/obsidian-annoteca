/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><div></div><span></span><button></button><textarea></textarea><select><option></option></select></div></body></html>"}
 */
// The outside-click draft guard in dismissReplyOnOutsideClick, exercised
// against a REAL EditorView with the composer mounted where CodeMirror
// actually mounts it: on the per-view tooltip host OUTSIDE `view.dom`
// (see `perWindowTooltipHost`).
//
// That mount point is the whole bug this pins. The guard reads the composer's
// textarea to decide whether an outside mousedown may dismiss it, and a
// `view.dom.querySelector` cannot see a tooltip mounted on the host, so it
// read every composer as empty and threw typed text off the screen. The fix
// asks `getTooltip(view, tooltip)` instead. Reverting that one call leaves
// every other suite green; this file is the coverage for it.
//
// The marker is id-less on purpose: without an id there is no draft key, so
// the guard is the ONLY thing standing between a stray click and the typed
// reply. It is also the shape the importer emits.

import { EditorState } from '@codemirror/state';
import { EditorView, showTooltip } from '@codemirror/view';

import {
	buildAnnotecaExtension,
	findMarkersInDoc,
	setReplyComposerEffect,
} from '../decorations';
import { DEFAULT_SETTINGS } from '../settings';
import type { AnnotecaSettings } from '../types';
import { installObsidianDomHelpers } from './obsidian-dom-helpers';
import { stubDecorationContext } from './stub-context';

const DOC = 'Prose before. <!-- annoteca/clarify: needs a source --> after.';
const MARKER_START = findMarkersInDoc(DOC)[0]!.marker.start;

let settings: AnnotecaSettings;

const views: EditorView[] = [];

function openView(): EditorView {
	const view = new EditorView({
		state: EditorState.create({
			doc: DOC,
			extensions: [
				buildAnnotecaExtension(stubDecorationContext(() => settings)),
			],
		}),
		parent: document.body,
	});
	views.push(view);
	return view;
}

// Lets the tooltip host claim its parent and CodeMirror mount the tooltip:
// both run through 0 ms timers (`claimHost`, the composer's focus deferral),
// so one real-timer hop after each dispatch is what "rendered" means here.
function settle(): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, 30);
	});
}

async function openComposer(view: EditorView): Promise<HTMLTextAreaElement> {
	await settle();
	view.dispatch({ effects: setReplyComposerEffect.of(MARKER_START) });
	await settle();
	const textarea = document.querySelector<HTMLTextAreaElement>(
		'.annoteca-reply-composer-textarea',
	);
	if (!textarea) throw new Error('composer did not mount');
	return textarea;
}

function composerCount(view: EditorView): number {
	return view.state.facet(showTooltip).filter(Boolean).length;
}

function mousedownInEditor(view: EditorView): void {
	view.contentDOM.dispatchEvent(
		new MouseEvent('mousedown', { bubbles: true }),
	);
}

beforeAll(() => {
	installObsidianDomHelpers();
	window.activeDocument = document;
	window.activeWindow = window;
});

beforeEach(() => {
	settings = { ...DEFAULT_SETTINGS, indicatorStyle: 'underline' };
});

afterEach(() => {
	while (views.length > 0) views.pop()?.destroy();
	document.body.replaceChildren();
});

describe('dismissReplyOnOutsideClick and the typed-text guard', () => {
	it('mounts the composer outside view.dom, the premise of the guard', async () => {
		const view = openView();
		const textarea = await openComposer(view);

		// If this ever fails, tooltips have started mounting inside the view
		// again and the guard's getTooltip lookup needs a fresh look.
		expect(textarea.isConnected).toBe(true);
		expect(view.dom.contains(textarea)).toBe(false);
	});

	it('keeps a composer holding typed text through an outside mousedown', async () => {
		const view = openView();
		const textarea = await openComposer(view);
		textarea.value = 'unsent reply';
		textarea.dispatchEvent(new Event('input', { bubbles: true }));

		mousedownInEditor(view);
		await settle();

		expect(composerCount(view)).toBe(1);
		const after = document.querySelector<HTMLTextAreaElement>(
			'.annoteca-reply-composer-textarea',
		);
		expect(after).toBe(textarea);
		expect(after?.value).toBe('unsent reply');
	});

	it('still dismisses an empty composer on an outside mousedown', async () => {
		const view = openView();
		await openComposer(view);

		mousedownInEditor(view);
		await settle();

		expect(composerCount(view)).toBe(0);
		expect(
			document.querySelector('.annoteca-reply-composer-textarea'),
		).toBeNull();
	});
});
