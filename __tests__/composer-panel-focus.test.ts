// The side-panel composer puts the caret in the body field when a comment is
// requested, and at no other time.
//
// The modal has focused the body since #21. The panel did not, on the reasoning
// that a panel left open should not pull focus out of the editor. That holds
// for the panel's own renders (opening with no request, resetting after Save
// or Cancel), but a new request only ever comes from someone asking to
// comment, so leaving the caret in the editor there just cost a click.
//
// `render` and `focusBody` are stubbed on the prototype: rendering needs
// Obsidian's DOM extensions and Setting widget, which jsdom does not have, and
// focusBody's own deferral is verified in the running app. What is under test
// is which panel paths ask for focus.

import type { WorkspaceLeaf } from 'obsidian';
import type AnnotecaPlugin from '../main';
import { ComposerForm, type ComposerRequest } from '../composer';
import { ComposerPanelView } from '../views';
import { DEFAULT_SETTINGS } from '../settings';

interface PanelInternals {
	contentEl: unknown;
}

function makePanel(): ComposerPanelView {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS },
	} as unknown as AnnotecaPlugin;
	const view = new ComposerPanelView({} as WorkspaceLeaf, plugin);
	// The mock ItemView has no contentEl. The empty-state render calls these
	// three; the form render is stubbed below.
	(view as unknown as PanelInternals).contentEl = {
		empty: () => undefined,
		addClass: () => undefined,
		createEl: () => undefined,
	};
	return view;
}

function makeRequest(): ComposerRequest {
	return {
		editor: {},
		view: {},
		filePath: 'note.md',
	} as unknown as ComposerRequest;
}

let focusCalls: number;
let closeHook: (() => void) | undefined;

beforeEach(() => {
	focusCalls = 0;
	closeHook = undefined;
	jest.spyOn(ComposerForm.prototype, 'render').mockImplementation(function (
		this: ComposerForm,
	) {
		// The hooks the panel passed, so a test can drive Save or Cancel.
		closeHook = (this as unknown as { hooks: { close: () => void } }).hooks
			.close;
	});
	jest.spyOn(ComposerForm.prototype, 'focusBody').mockImplementation(() => {
		focusCalls += 1;
	});
});

afterEach(() => {
	jest.restoreAllMocks();
});

describe('side-panel composer focus', () => {
	it('focuses the body when a comment is requested', () => {
		const view = makePanel();

		view.setRequest(makeRequest());

		expect(focusCalls).toBe(1);
	});

	it('focuses again for each new request', () => {
		const view = makePanel();

		view.setRequest(makeRequest());
		view.setRequest(makeRequest());

		expect(focusCalls).toBe(2);
	});

	it('does not take focus when the panel opens with no request', async () => {
		const view = makePanel();

		await view.onOpen();

		expect(focusCalls).toBe(0);
	});

	it('does not take focus when it re-renders an open request', async () => {
		const view = makePanel();
		view.setRequest(makeRequest());

		// onOpen renders whatever request is pending, without asking for focus.
		await view.onOpen();

		expect(focusCalls).toBe(1);
	});

	it('does not take focus when Save or Cancel resets the panel', () => {
		const view = makePanel();
		view.setRequest(makeRequest());

		expect(closeHook).toBeDefined();
		closeHook?.();

		expect(focusCalls).toBe(1);
	});
});
