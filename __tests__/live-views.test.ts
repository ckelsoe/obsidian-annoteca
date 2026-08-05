/**
 * @jest-environment jsdom
 */
// The live-view registry, exercised against REAL EditorViews.
//
// This is the half of CodeRabbit's #16 nitpick that PR #17 left open:
// `trackLiveView` registers each view and the broadcast helpers dispatch into
// every registered one, and nothing constructed an `EditorView` to prove it.
// The rest of the suite runs on testEnvironment "node", which has no DOM, so
// this file opts into jsdom on its own rather than moving all 16 suites onto a
// heavier environment they do not need.
//
// It matters more than it did when #16 raised it: one function iterated
// `liveViews` then, and three do now, one of which runs on every settings save.
//
// Everything here uses indicatorStyle "underline" on purpose. That draws
// `Decoration.mark` only, so no widget `toDOM` runs, so the test needs none of
// the DOM helpers Obsidian injects (`document.win.createSpan` and friends) that
// jsdom does not have. Stubbing those would mean a hand-written imitation of
// Obsidian standing between the test and the thing it claims to verify. The
// widget rendering itself is covered headlessly in decorations.test.ts and was
// verified in the real app; what is under test HERE is the registry.

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
	buildAnnotecaExtension,
	setHideAllCommentsEverywhere,
	isHideAllComments,
	setShowCommentBodiesEverywhere,
	isShowingCommentBodies,
	refreshDecorationsEverywhere,
} from '../decorations';
import { DEFAULT_SETTINGS } from '../settings';
import type { AnnotecaSettings } from '../types';
import { stubDecorationContext } from './stub-context';

// The anchor line is what makes the underline resolve; without it there is
// nothing for `findAnchorRange` to match and the mark is never emitted.
const ANCHOR = 'Prose before.';
const DOC = `${ANCHOR} <!-- annoteca/clarify: needs a source
[anchor=${ANCHOR}]
--> after.`;

// Held so a test can mutate settings in place, the way the settings tab does.
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

// What the view is actually drawing. The registry is only worth anything if a
// broadcast changes what the user sees, so this asserts on rendered DOM rather
// than on a state field.
function anchorCount(view: EditorView): number {
	return view.dom.querySelectorAll('.annoteca-anchor').length;
}

beforeAll(() => {
	// The selection popup builds its DOM through `activeWindow`. Obsidian sets
	// that on every window at runtime; jsdom does not, so the test supplies it.
	// The type already exists on Window via obsidian.d.ts, so this needs no
	// assertion and no addition to globals.d.ts.
	//
	// Tooltips themselves no longer go anywhere near `activeDocument`: each
	// editor mounts them in its own window through `perWindowTooltipHost`.
	window.activeDocument = document;
	window.activeWindow = window;
});

beforeEach(() => {
	settings = { ...DEFAULT_SETTINGS, indicatorStyle: 'underline' };
});

afterEach(() => {
	// Destroying every view also empties the registry via `trackLiveView`'s
	// `destroy`, so one test's panes cannot receive the next test's broadcasts.
	// Wrapped because a throw partway through would leave views registered AND
	// skip the flag reset below, turning one failure into a cascade of
	// unrelated ones in later tests.
	try {
		while (views.length > 0) views.pop()?.destroy();
	} finally {
		if (isHideAllComments()) setHideAllCommentsEverywhere(false);
		if (isShowingCommentBodies()) setShowCommentBodiesEverywhere(false);
		document.body.innerHTML = '';
	}
});

describe('the live-view registry reaches real editors', () => {
	it('registers a view on construction and repaints it on broadcast', () => {
		const view = openView();
		expect(anchorCount(view)).toBe(1);

		setHideAllCommentsEverywhere(true);

		// Nothing was dispatched into this view directly. It only repaints if
		// `trackLiveView` put it in the registry and the broadcast found it.
		expect(anchorCount(view)).toBe(0);
	});

	it('reaches every open view, not just the most recent', () => {
		const first = openView();
		const second = openView();

		setHideAllCommentsEverywhere(true);

		expect(anchorCount(first)).toBe(0);
		expect(anchorCount(second)).toBe(0);
	});

	it('deregisters on destroy, and the broadcast survives it', () => {
		const staying = openView();
		const closing = openView();

		closing.destroy();
		views.splice(views.indexOf(closing), 1);

		// A destroyed CodeMirror view throws if dispatched into, so a registry
		// that leaked it would take the whole broadcast down with it and the
		// surviving pane would never repaint.
		expect(() => setHideAllCommentsEverywhere(true)).not.toThrow();
		expect(anchorCount(staying)).toBe(0);
	});

	it('broadcasts a settings change, with no document or selection touched', () => {
		const view = openView();
		expect(anchorCount(view)).toBe(1);

		// Exactly what the settings tab does: mutate the live settings object,
		// then save. Before the epoch existed this repainted only on the next
		// click or keystroke in the editor.
		settings.indicatorStyle = 'none';
		refreshDecorationsEverywhere();

		expect(anchorCount(view)).toBe(0);
	});

	it('a view opened after a broadcast adopts the current state', () => {
		setHideAllCommentsEverywhere(true);

		// This view never received the effect; it reads the module flag in the
		// field's `create`. That is the only path that consults the flag, and
		// it is what keeps a newly opened pane consistent with the rest.
		expect(anchorCount(openView())).toBe(0);
	});
});
