// The delete-confirmation modal's cancel signal.
//
// Two lifecycle verbs wrap this modal in a promise, and without a cancel signal
// that promise never settled: backing out left it pending for the life of the
// session. Wiring the signal to the Cancel BUTTON was not enough either, because
// the button is only one of the ways out. Escape and a click on the background
// both go straight to onClose, and those are the common dismissals.
//
// Driven by calling the lifecycle methods directly. The Jest Modal stub has no
// contentEl (the real one comes from the plugin host), so the test supplies the
// one thing onClose touches.

import { ConfirmDeleteCommentModal } from '../confirm-modal';
import { DEFAULT_SETTINGS } from '../settings';
import type { App } from 'obsidian';
import type { Comment } from '../types';

const COMMENT: Comment = {
	id: 'cnf00001',
	category: 'clarify',
	body: 'a comment',
	date: undefined,
	author: undefined,
	anchor: undefined,
	replies: [],
	addressed: undefined,
	resolution: undefined,
	marker: { start: 0, end: 0 },
};

function makeModal(onConfirm: () => void, onCancel: () => void) {
	const modal = new ConfirmDeleteCommentModal(
		{} as App,
		DEFAULT_SETTINGS,
		COMMENT,
		onConfirm,
		{ title: 'Delete comment', cta: 'Delete' },
		onCancel,
	);
	Object.assign(modal, {
		contentEl: { empty: () => undefined },
		close: () => modal.onClose(),
	});
	return modal;
}

describe('ConfirmDeleteCommentModal cancellation', () => {
	it('signals cancel when the modal is dismissed without confirming', () => {
		let cancelled = 0;
		const modal = makeModal(
			() => undefined,
			() => {
				cancelled++;
			},
		);
		// Escape, or a click on the background: straight to onClose.
		modal.onClose();
		expect(cancelled).toBe(1);
	});

	it('does not signal cancel when the action was confirmed', () => {
		let cancelled = 0;
		let confirmed = 0;
		const modal = makeModal(
			() => {
				confirmed++;
			},
			() => {
				cancelled++;
			},
		);
		// What the CTA handler does: mark, close (which runs onClose), confirm.
		(modal as unknown as { confirmed: boolean }).confirmed = true;
		modal.onClose();
		modal.onClose();
		expect(cancelled).toBe(0);
		expect(confirmed).toBe(0);
	});
});
