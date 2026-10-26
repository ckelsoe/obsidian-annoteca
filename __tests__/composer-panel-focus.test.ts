/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><div></div><textarea></textarea><p></p></div></body></html>"}
 */
// The side-panel composer puts the caret in the body field when a comment is
// requested, and at no other time.
//
// The modal has focused the body since #21. The panel did not, on the reasoning
// that a panel left open should not pull focus out of the editor. That holds
// for the panel's own renders (opening with no request, resetting after Save
// or Cancel), but a new request only ever comes from someone asking to
// comment, so leaving the caret in the editor there just cost a click.
//
// `render` is stubbed on the prototype in both suites: the real one builds
// Setting rows, and the mock Setting is an empty class. The routing suite also
// stubs `focusBody` to count which panel paths ask for focus. The focus suite
// keeps `focusBody` real and gives it a real, attached textarea, so its
// deferral, caret placement and detached-element guard run as written.

import type { WorkspaceLeaf } from 'obsidian';
import type AnnotecaPlugin from '../main';
import { ComposerForm, type ComposerRequest } from '../composer';
import { ComposerPanelView } from '../views';
import { DEFAULT_SETTINGS } from '../settings';
import { installObsidianDomHelpers } from '../__mocks__/obsidian';

interface PanelInternals {
	contentEl: unknown;
}

interface FormInternals {
	hooks: { close: () => void };
	bodyArea?: HTMLTextAreaElement;
}

function makePanel(contentEl: unknown): ComposerPanelView {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS },
	} as unknown as AnnotecaPlugin;
	const view = new ComposerPanelView({} as WorkspaceLeaf, plugin);
	// The mock ItemView has no contentEl.
	(view as unknown as PanelInternals).contentEl = contentEl;
	return view;
}

function makeRequest(): ComposerRequest {
	return {
		editor: {},
		view: {},
		filePath: 'note.md',
	} as unknown as ComposerRequest;
}

beforeAll(() => {
	installObsidianDomHelpers();
});

afterEach(() => {
	jest.restoreAllMocks();
	jest.useRealTimers();
});

describe('side-panel composer focus routing', () => {
	let focusCalls: number;
	let closeHook: (() => void) | undefined;

	// The empty-state render calls these three; the form render is stubbed.
	const stubContent = (): unknown => ({
		empty: () => undefined,
		addClass: () => undefined,
		createEl: () => undefined,
	});

	beforeEach(() => {
		focusCalls = 0;
		closeHook = undefined;
		jest.spyOn(ComposerForm.prototype, 'render').mockImplementation(
			function (this: ComposerForm) {
				// The hooks the panel passed, so a test can drive Save or Cancel.
				closeHook = (this as unknown as FormInternals).hooks.close;
			},
		);
		jest.spyOn(ComposerForm.prototype, 'focusBody').mockImplementation(
			() => {
				focusCalls += 1;
			},
		);
	});

	it('focuses the body when a comment is requested', () => {
		const view = makePanel(stubContent());

		view.setRequest(makeRequest());

		expect(focusCalls).toBe(1);
	});

	it('focuses again for each new request', () => {
		const view = makePanel(stubContent());

		view.setRequest(makeRequest());
		view.setRequest(makeRequest());

		expect(focusCalls).toBe(2);
	});

	it('does not take focus when the panel opens with no request', async () => {
		const view = makePanel(stubContent());

		await view.onOpen();

		expect(focusCalls).toBe(0);
	});

	it('does not take focus when it re-renders an open request', async () => {
		const view = makePanel(stubContent());
		view.setRequest(makeRequest());

		// onOpen renders whatever request is pending, without asking for focus.
		await view.onOpen();

		expect(focusCalls).toBe(1);
	});

	it('does not take focus when Save or Cancel resets the panel', () => {
		const view = makePanel(stubContent());
		view.setRequest(makeRequest());

		expect(closeHook).toBeDefined();
		closeHook?.();

		expect(focusCalls).toBe(1);
	});
});

describe('side-panel composer focus in the DOM', () => {
	let container: HTMLDivElement;

	beforeEach(() => {
		jest.useFakeTimers();
		container = window.createDiv();
		document.body.append(container);
		// Stands in for the real render's body field: a textarea in the
		// container, recorded where focusBody looks for it.
		jest.spyOn(ComposerForm.prototype, 'render').mockImplementation(
			function (this: ComposerForm, el: HTMLElement) {
				const area = el.createEl('textarea');
				area.value = 'existing text';
				(this as unknown as FormInternals).bodyArea = area;
			},
		);
	});

	afterEach(() => {
		container.remove();
	});

	it('puts the caret at the end of the body after a turn', () => {
		const view = makePanel(container);

		view.setRequest(makeRequest());
		const area = container.querySelector('textarea');
		// Assigning a value already leaves jsdom's caret at the end, so move
		// it to the start, or the caret assertions below prove nothing.
		area?.setSelectionRange(0, 0);

		// Deferred, because Obsidian moves focus itself right after a view
		// opens and would overwrite an immediate focus.
		expect(document.activeElement).not.toBe(area);
		jest.runOnlyPendingTimers();

		expect(document.activeElement).toBe(area);
		expect(area?.selectionStart).toBe('existing text'.length);
		expect(area?.selectionEnd).toBe('existing text'.length);
	});

	it('does not focus a body the panel removed before the turn ran', () => {
		const view = makePanel(container);

		view.setRequest(makeRequest());
		const area = container.querySelector('textarea');
		if (!area) throw new Error('render made no textarea');
		// jsdom ignores focus() on a detached element, so activeElement alone
		// would pass without the guard. Watch the call itself.
		const focus = jest.spyOn(area, 'focus');
		container.empty();
		jest.runOnlyPendingTimers();

		expect(area.isConnected).toBe(false);
		expect(focus).not.toHaveBeenCalled();
	});
});
