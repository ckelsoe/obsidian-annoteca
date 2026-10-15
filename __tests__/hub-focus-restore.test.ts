/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><div></div><textarea></textarea></div></body></html>"}
 */
// The hub panel rebuilds on every index change, which arrives while the reader
// is typing a reply. captureFocus has to put the cursor back in the SAME
// comment's reply box, even when a comment arriving above it has moved that box
// to a new position in the list.

import { captureFocus } from '../views';
import { FOCUS_KEY_ATTR } from '../view-utils';
import { installObsidianDomHelpers } from '../__mocks__/obsidian';

beforeAll(() => installObsidianDomHelpers());

function drawList(root: HTMLElement, ids: readonly string[]): void {
	root.empty();
	for (const id of ids) {
		const box = root.createDiv({ cls: 'card' }).createEl('textarea', {
			cls: 'annoteca-reply-input',
		});
		box.setAttribute(FOCUS_KEY_ATTR, `a.md#${id}`);
		box.value = `draft ${id}`;
	}
}

const boxFor = (root: HTMLElement, id: string): HTMLTextAreaElement => {
	const found = Array.from(
		root.querySelectorAll<HTMLTextAreaElement>('.annoteca-reply-input'),
	).find((el) => el.getAttribute(FOCUS_KEY_ATTR) === `a.md#${id}`);
	if (!found) throw new Error(`no box for ${id}`);
	return found;
};

describe('captureFocus in the hub', () => {
	it('follows the reply box by comment when a new comment lands above it', () => {
		const root = document.body.createDiv();
		drawList(root, ['aaaaaaaa', 'bbbbbbbb']);
		const box = boxFor(root, 'bbbbbbbb');
		box.focus();
		box.setSelectionRange(2, 5);

		const restore = captureFocus(root);
		// The rebuild: a new comment arrived first in the list.
		drawList(root, ['newnewnw', 'aaaaaaaa', 'bbbbbbbb']);
		restore();

		const again = boxFor(root, 'bbbbbbbb');
		expect(again).not.toBe(box);
		expect(document.activeElement).toBe(again);
		expect([again.selectionStart, again.selectionEnd]).toEqual([2, 5]);
	});

	it('restores nothing when the focused comment is gone', () => {
		const root = document.body.createDiv();
		drawList(root, ['aaaaaaaa', 'bbbbbbbb']);
		boxFor(root, 'bbbbbbbb').focus();
		const restore = captureFocus(root);
		drawList(root, ['aaaaaaaa']);
		restore();
		expect(document.activeElement).not.toBe(boxFor(root, 'aaaaaaaa'));
	});

	it('does nothing when focus was outside the panel', () => {
		const root = document.body.createDiv();
		drawList(root, ['aaaaaaaa']);
		const outside = document.body.createEl('textarea');
		outside.focus();
		const restore = captureFocus(root);
		drawList(root, ['aaaaaaaa']);
		restore();
		expect(document.activeElement).toBe(outside);
	});
});
