// Shared `DecorationContext` double.
//
// Not named `*.test.ts` so Jest does not collect it as a suite. Extracted when
// a second suite needed the same eighteen no-op members; the only thing the two
// callers differ on is how settings are supplied, so that is the one parameter.

import type { DecorationContext } from '../decorations';
import type { AnnotecaSettings, CategoryDefinition } from '../types';

// `getSettings` is taken as a callback rather than a value so a caller can hand
// back a mutable object and change it mid-test, which is what the settings tab
// does to the live settings.
export function stubDecorationContext(
	getSettings: () => AnnotecaSettings,
): DecorationContext {
	const noop = () => undefined;
	return {
		getSettings,
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
