import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
	buildMarkerDecorations,
	setHideAllCommentsEffect,
	setHideAllCommentsEverywhere,
	isHideAllComments,
	type DecorationContext,
} from '../decorations';
import { DEFAULT_SETTINGS } from '../settings';
import type { CategoryDefinition } from '../types';

function stubCtx(): DecorationContext {
	const noop = () => undefined;
	return {
		getSettings: () => DEFAULT_SETTINGS,
		onMarkerClick: noop,
		openInReviewer: noop,
		addCommentForSelection: noop,
		categoryFor: (id: string): CategoryDefinition => ({
			id,
			displayName: id,
		}),
		toggleResolution: noop,
		resolveAndRemove: noop,
		acceptAddressed: noop,
		reviseAddressed: noop,
		rejectAddressed: noop,
		copyPermalink: noop,
		submitReply: noop,
		getAuthorTag: () => 'ck',
		getAuthorOptions: () => ['ck'],
		authorColor: () => undefined,
		isStarred: () => false,
		toggleStarred: noop,
		loadDraft: () => '',
		saveDraft: noop,
		clearDraft: noop,
	};
}

const DOC = 'Prose before. <!-- annoteca/clarify: needs a source --> after.';

function makeState(): EditorState {
	return EditorState.create({
		doc: DOC,
		extensions: [buildMarkerDecorations(stubCtx()).extension],
	});
}

// Total number of decorations the state currently computes. Function-valued
// entries are view-dependent and never produced by this plugin's sources.
function decoCount(state: EditorState): number {
	let n = 0;
	for (const set of state.facet(EditorView.decorations)) {
		if (typeof set === 'function') continue;
		n += set.size;
	}
	return n;
}

describe('hide-all repaints on its own transaction', () => {
	afterEach(() => {
		// The cross-editor flag is module state; leaving it set would leak into
		// the next test's `create()`. No live views are registered here (these
		// tests build state headlessly, never an EditorView), so this only
		// resets the flag.
		if (isHideAllComments()) setHideAllCommentsEverywhere(false);
	});

	it('draws marker decorations by default', () => {
		expect(decoCount(makeState())).toBeGreaterThan(0);
	});

	it('clears decorations on the effect alone, with no document change', () => {
		const state = makeState();
		const before = decoCount(state);
		expect(before).toBeGreaterThan(0);

		const hidden = state.update({
			effects: setHideAllCommentsEffect.of(true),
		}).state;

		// The regression: this used to stay at `before`, because the decoration
		// sources read a module-level global that CodeMirror did not track, so
		// nothing recomputed until an unrelated edit or selection move.
		expect(decoCount(hidden)).toBe(0);
		expect(hidden.doc.toString()).toBe(DOC);
	});

	it('restores decorations when toggled back off', () => {
		const hidden = makeState().update({
			effects: setHideAllCommentsEffect.of(true),
		}).state;
		expect(decoCount(hidden)).toBe(0);

		const shown = hidden.update({
			effects: setHideAllCommentsEffect.of(false),
		}).state;
		expect(decoCount(shown)).toBeGreaterThan(0);
	});

	it('leaves the parsed markers alone while hidden', () => {
		const hidden = makeState().update({
			effects: setHideAllCommentsEffect.of(true),
		}).state;
		// Hiding is presentation only. The comment is still in the document and
		// still parsed, so the panel and every command keep working.
		expect(hidden.doc.toString()).toContain('annoteca/clarify');
	});
});
