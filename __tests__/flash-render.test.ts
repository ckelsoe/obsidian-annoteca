/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><div></div><span></span><button></button><textarea></textarea><select><option></option></select></div></body></html>"}
 */
// #82: the arrival flash as it is DRAWN, in the default indicator style.
//
// The default style ("both") replaces each marker with an icon widget, so a
// mark over the marker range never reaches the DOM. A comment with no anchor
// and no edited prose has only its marker to flash, so the icon has to paint
// the flash itself. live-views.test.ts runs in underline style and cannot see
// this, which is how it was first missed.

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
	buildAnnotecaExtension,
	findMarkersInDoc,
	flashComment,
} from '../decorations';
import { DEFAULT_SETTINGS } from '../settings';
import { installObsidianDomHelpers } from '../__mocks__/obsidian';
import { stubDecorationContext } from './stub-context';

const DOC = 'Prose before. <!-- annoteca/clarify: needs a source --> after.';

const views: EditorView[] = [];

function openView(): EditorView {
	const settings = { ...DEFAULT_SETTINGS, indicatorStyle: 'both' as const };
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

const start = (): number => {
	const m = findMarkersInDoc(DOC)[0];
	if (!m) throw new Error('fixture has no marker');
	return m.marker.start;
};

const flashingIcon = (view: EditorView): HTMLElement | null =>
	view.dom.querySelector<HTMLElement>(
		'.annoteca-icon.annoteca-flash-comment',
	);

beforeAll(() => {
	installObsidianDomHelpers();
	window.activeDocument = document;
	window.activeWindow = window;
});

beforeEach(() => jest.useFakeTimers());

afterEach(() => {
	jest.useRealTimers();
	while (views.length > 0) views.pop()?.destroy();
	document.body.querySelectorAll('.cm-editor').forEach((e) => e.remove());
});

describe('#82: the flash on a marker drawn as an icon', () => {
	it('the icon itself carries the flash, then loses it', () => {
		const view = openView();
		expect(view.dom.querySelector('.annoteca-icon')).not.toBeNull();
		expect(flashingIcon(view)).toBeNull();
		flashComment(view, start());
		expect(flashingIcon(view)).not.toBeNull();
		jest.advanceTimersByTime(1500);
		expect(flashingIcon(view)).toBeNull();
		// The icon is still there, only the flash is gone.
		expect(view.dom.querySelector('.annoteca-icon')).not.toBeNull();
	});

	it('a repeat jump draws a fresh element so the animation restarts', () => {
		const view = openView();
		flashComment(view, start());
		const first = flashingIcon(view);
		jest.advanceTimersByTime(500);
		flashComment(view, start());
		const second = flashingIcon(view);
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(second).not.toBe(first);
	});
});
