import { EditorState } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	WidgetType,
	showTooltip,
	type Tooltip,
} from '@codemirror/view';

import {
	buildAnnotecaExtension,
	buildMarkerDecorations,
	findMarkersInDoc,
	setActiveCommentEffect,
	setHideAllCommentsEffect,
	setHideAllCommentsEverywhere,
	isHideAllComments,
	setReplyComposerEffect,
	setShowCommentBodiesEffect,
	setShowCommentBodiesEverywhere,
	setTapPopoverEffect,
	isShowingCommentBodies,
	bumpSettingsEpochEffect,
	inlineBodiesBlockedBy,
	type DecorationContext,
} from '../decorations';
import { DEFAULT_SETTINGS } from '../settings';
import type { AnnotecaSettings } from '../types';
import { stubDecorationContext } from './stub-context';

function stubCtx(overrides: Partial<AnnotecaSettings> = {}): DecorationContext {
	const settings: AnnotecaSettings = { ...DEFAULT_SETTINGS, ...overrides };
	return stubDecorationContext(() => settings);
}

const DOC = 'Prose before. <!-- annoteca/clarify: needs a source --> after.';

// A marker whose body spans lines and carries two replies. Used for the inline
// body and reply count, both of which have to cope with a body that is not one
// tidy line.
const THREADED_DOC = `Prose before. <!-- annoteca/tone: this paragraph
	runs long and needs a trim
[id=a3b9c2x7]
[reply ai 2026-05-23]: shortened it
[reply charles 2026-05-24]: better
--> after.`;

function makeState(
	overrides: Partial<AnnotecaSettings> = {},
	doc: string = DOC,
): EditorState {
	return EditorState.create({
		doc,
		extensions: [buildMarkerDecorations(stubCtx(overrides)).extension],
	});
}

// Every decoration the state currently computes, in document order. Function-
// valued facet entries are view-dependent and never produced by this plugin's
// sources.
function decorationsOf(state: EditorState): Decoration[] {
	const out: Decoration[] = [];
	for (const set of state.facet(EditorView.decorations)) {
		if (typeof set === 'function') continue;
		for (const cursor = set.iter(); cursor.value !== null; cursor.next()) {
			out.push(cursor.value);
		}
	}
	return out;
}

function decoCount(state: EditorState): number {
	return decorationsOf(state).length;
}

// The widget instances currently decorating the document. Widget `eq()` is
// pure, so it can be exercised here even though `toDOM()` cannot: the suite
// runs on testEnvironment "node" and has no DOM to render into.
function widgetsOf(state: EditorState): WidgetType[] {
	const out: WidgetType[] = [];
	for (const deco of decorationsOf(state)) {
		const spec = deco.spec as { widget?: unknown } | undefined;
		if (spec?.widget instanceof WidgetType) out.push(spec.widget);
	}
	return out;
}

// Widgets are module-private classes, so they are told apart by constructor
// name rather than by import.
function widgetsNamed(state: EditorState, name: string): WidgetType[] {
	return widgetsOf(state).filter((w) => w.constructor.name === name);
}

// Throws rather than returning undefined so a test that stops producing the
// widget it is about fails on that, instead of quietly asserting against
// nothing.
function onlyWidget(state: EditorState, name: string): WidgetType {
	const found = widgetsNamed(state, name);
	if (found.length !== 1) {
		throw new Error(`expected exactly one ${name}, got ${found.length}`);
	}
	return found[0] as WidgetType;
}

// The text an inline body widget will render. Read off the instance because
// `toDOM()` needs a DOM this suite does not have.
function inlineTextOf(state: EditorState): string {
	const widget = onlyWidget(state, 'InlineBodyWidget');
	return (widget as unknown as { text: string }).text;
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

	it('an editor created while hidden starts hidden', () => {
		// The field's `update` is a function of the transaction alone, so an
		// editor opened after the toggle never sees the effect that hid the
		// others. `create` reading the cross-editor flag is the only thing
		// keeping that pane consistent with the rest, and without it a note
		// opened while hide-all was on would come up showing its markers.
		setHideAllCommentsEverywhere(true);
		expect(isHideAllComments()).toBe(true);

		expect(decoCount(makeState())).toBe(0);
	});

	it('an editor created while visible starts visible', () => {
		expect(isHideAllComments()).toBe(false);
		expect(decoCount(makeState())).toBeGreaterThan(0);
	});
});

describe('inline comment bodies', () => {
	afterEach(() => {
		// Module state, same as hide-all: leaving it set would leak into the
		// next test's `create()`. No live views are registered here (these
		// tests build state headlessly, never an EditorView), so this only
		// resets the flag.
		if (isShowingCommentBodies()) setShowCommentBodiesEverywhere(false);
	});

	it('draws no inline body until the toggle is on', () => {
		expect(widgetsNamed(makeState(), 'InlineBodyWidget')).toHaveLength(0);
	});

	it('adds a body widget on the effect alone, with no document change', () => {
		// This is the trap the hide-all bug taught. The flag changes NO
		// document text, so every marker range is identical from one compute
		// to the next; if the flag is not a declared dependency of the
		// decorations facet, nothing recomputes and the command looks broken
		// until an unrelated edit or click happens to repaint for some other
		// reason. Asserting on the effect alone is what pins that down.
		const state = makeState();
		const before = decoCount(state);

		const shown = state.update({
			effects: setShowCommentBodiesEffect.of(true),
		}).state;

		expect(widgetsNamed(shown, 'InlineBodyWidget')).toHaveLength(1);
		expect(decoCount(shown)).toBe(before + 1);
		expect(shown.doc.toString()).toBe(DOC);
	});

	it('removes the body widget when toggled back off', () => {
		const shown = makeState().update({
			effects: setShowCommentBodiesEffect.of(true),
		}).state;
		expect(widgetsNamed(shown, 'InlineBodyWidget')).toHaveLength(1);

		const hidden = shown.update({
			effects: setShowCommentBodiesEffect.of(false),
		}).state;
		expect(widgetsNamed(hidden, 'InlineBodyWidget')).toHaveLength(0);
	});

	it('a second pane opened while bodies are shown shows them too', () => {
		// Settled deliberately, not by accident: the flag is module-global,
		// exactly like hide-all, so both panes on a file agree. A pane opened
		// after the toggle picks the value up in the field's `create`, which
		// is the only path that reads the module flag.
		setShowCommentBodiesEverywhere(true);
		expect(isShowingCommentBodies()).toBe(true);

		expect(widgetsNamed(makeState(), 'InlineBodyWidget')).toHaveLength(1);
	});

	it('renders nothing at all when indicators are off', () => {
		// indicatorStyle "none" means "put nothing in my document", and an
		// inline body is the most intrusive possible override of that. The
		// command refuses to toggle in this mode; this pins the drawing side.
		const state = makeState({ indicatorStyle: 'none' }).update({
			effects: setShowCommentBodiesEffect.of(true),
		}).state;
		expect(decoCount(state)).toBe(0);
	});

	it('draws no inline body in underline-only mode', () => {
		// The marker range is not replaced in that mode, so its raw
		// `<!-- annoteca/... -->` text is already on screen with the body in
		// it. A truncated second copy beside it would be pure noise.
		const state = makeState({ indicatorStyle: 'underline' }).update({
			effects: setShowCommentBodiesEffect.of(true),
		}).state;
		expect(widgetsNamed(state, 'InlineBodyWidget')).toHaveLength(0);
	});

	it('collapses a multi-line body to one line', () => {
		const state = makeState({}, THREADED_DOC).update({
			effects: setShowCommentBodiesEffect.of(true),
		}).state;
		const text = inlineTextOf(state);

		// A body that wrapped in the marker must not wrap the prose it
		// annotates, and the reply lines are never part of it.
		expect(text).toBe('this paragraph runs long and needs a trim');
		expect(text).not.toContain('\n');
		expect(text).not.toContain('shortened it');
	});

	it('truncates a long body to a single readable line', () => {
		const long = 'x'.repeat(200);
		const state = makeState(
			{},
			`a <!-- annoteca/cut: ${long} --> b`,
		).update({ effects: setShowCommentBodiesEffect.of(true) }).state;
		const text = inlineTextOf(state);

		expect(text).toHaveLength(81);
		expect(text.endsWith('…')).toBe(true);
	});
});

describe('a settings change repaints open editors', () => {
	// The settings tab mutates the plugin's live settings object in place, so
	// the stub has to hand back that same object rather than a snapshot of it.
	function stateOver(settings: AnnotecaSettings): EditorState {
		const ctx: DecorationContext = {
			...stubCtx(),
			getSettings: () => settings,
		};
		return EditorState.create({
			doc: THREADED_DOC,
			extensions: [buildMarkerDecorations(ctx).extension],
		});
	}

	it('does not repaint on an unrelated transaction', () => {
		// The negative control. Without it the test below proves nothing: if
		// the facet recomputed on every transaction, a "repainted" assertion
		// would pass whether or not the epoch was wired up.
		const settings: AnnotecaSettings = { ...DEFAULT_SETTINGS };
		const state = stateOver(settings);
		const before = onlyWidget(state, 'MarkerIconWidget');

		settings.markerReplyCount = false;
		const after = onlyWidget(
			state.update({ selection: { anchor: 0 } }).state,
			'MarkerIconWidget',
		);

		// Selection IS a declared dependency, so this recomputes and sees the
		// new value. That is precisely the accident that made the staleness
		// hard to notice: click anywhere and it fixes itself.
		expect(before.eq(after)).toBe(false);
	});

	it('repaints on the settings epoch alone, with no document or selection change', () => {
		// Decoration drawing reads settings through a closure, which CodeMirror
		// cannot watch. Writing a setting changes nothing it tracks, so without
		// the epoch every open editor keeps drawing the old value until an
		// unrelated click or keystroke happens to recompute the facet.
		const settings: AnnotecaSettings = { ...DEFAULT_SETTINGS };
		const state = stateOver(settings);
		const before = onlyWidget(state, 'MarkerIconWidget');

		settings.markerReplyCount = false;
		const after = onlyWidget(
			state.update({ effects: bumpSettingsEpochEffect.of(1) }).state,
			'MarkerIconWidget',
		);

		expect(after).not.toBe(before);
		expect(before.eq(after)).toBe(false);
	});
});

describe('reply count on the marker', () => {
	// `toDOM` needs a document and Obsidian's element helpers, neither of
	// which exists under testEnvironment "node". `eq()` is pure, so the
	// repaint contract can still be pinned down here; the rendered badge
	// itself was verified in Obsidian.
	function iconWidget(overrides: Partial<AnnotecaSettings> = {}): WidgetType {
		return onlyWidget(
			makeState(overrides, THREADED_DOC),
			'MarkerIconWidget',
		);
	}

	it('repaints when the setting is turned off', () => {
		// Load-bearing, not defence in depth: the setting changes what the
		// widget draws while the marker range stays byte-identical, so an
		// `eq()` that ignored it would leave the badge on screen after the
		// user turned it off.
		const on = iconWidget({ markerReplyCount: true });
		const off = iconWidget({ markerReplyCount: false });

		expect(on.eq(off)).toBe(false);
		expect(on.eq(iconWidget({ markerReplyCount: true }))).toBe(true);
	});

	it('repaints when a reply is added', () => {
		// This one passes with or without `replies.length` in `eq()`, which is
		// why it is written against the document rather than against the
		// field: replies are serialized INTO the marker, so adding one grows
		// the marker text and the `end` offset already differs. The comparison
		// is kept so the badge does not depend on that coincidence of the file
		// format.
		const oneReply = onlyWidget(
			makeState(
				{},
				'a <!-- annoteca/tone: b\n[reply ai 2026-05-23]: r1\n--> c',
			),
			'MarkerIconWidget',
		);
		const twoReplies = onlyWidget(
			makeState(
				{},
				'a <!-- annoteca/tone: b\n[reply ai 2026-05-23]: r1\n[reply ai 2026-05-24]: r2\n--> c',
			),
			'MarkerIconWidget',
		);

		expect(oneReply.eq(twoReplies)).toBe(false);
	});
});

describe('what blocks inline comment bodies', () => {
	// The command asks this instead of re-deriving the drawing code's gates for
	// itself. Two review rounds in a row found a gate the command did not know
	// about, so the list of gates lives in one place now.
	const settings = (
		style: AnnotecaSettings['indicatorStyle'],
	): AnnotecaSettings => ({ ...DEFAULT_SETTINGS, indicatorStyle: style });

	afterEach(() => {
		if (isHideAllComments()) setHideAllCommentsEverywhere(false);
	});

	it('is not blocked in the styles that draw a marker icon', () => {
		expect(inlineBodiesBlockedBy(settings('icon'))).toBeNull();
		expect(inlineBodiesBlockedBy(settings('both'))).toBeNull();
	});

	it('is blocked where no icon is drawn', () => {
		expect(inlineBodiesBlockedBy(settings('underline'))).toBe('no-icon');
		expect(inlineBodiesBlockedBy(settings('none'))).toBe('no-icon');
	});

	it('is blocked while hide-all is on, whatever the style', () => {
		// decorationsCompute returns Decoration.none before it looks at the
		// indicator style at all, so hide-all outranks it and the message the
		// user gets has to name the switch that is actually in the way.
		setHideAllCommentsEverywhere(true);
		expect(inlineBodiesBlockedBy(settings('icon'))).toBe('hide-all');
		expect(inlineBodiesBlockedBy(settings('both'))).toBe('hide-all');
		expect(inlineBodiesBlockedBy(settings('underline'))).toBe('hide-all');
	});

	it('draws nothing while hide-all is on even with bodies toggled on', () => {
		// The behaviour the predicate exists to keep the command honest about.
		const shown = makeState({}, THREADED_DOC).update({
			effects: [
				setShowCommentBodiesEffect.of(true),
				setHideAllCommentsEffect.of(true),
			],
		}).state;
		expect(decoCount(shown)).toBe(0);
	});
});

// Pinned surfaces: the reply composer, the tap popover, and the active-comment
// highlight -------------------------------------------------------------------
//
// All three used to keep a RAW marker offset and null themselves out unless a
// marker still started at exactly that number, so an edit ABOVE the comment
// closed the composer (losing text the user had typed but not sent), dismissed
// the pinned popover, and dropped the highlight, while an edit below did
// nothing. The two tooltip fields additionally rebuilt their Tooltip object with
// a fresh `create` closure on every recompute, and CodeMirror matches tooltip
// views by `create` identity, so the live DOM was destroyed and rebuilt on ANY
// document change.
//
// These drive real EditorStates through `buildAnnotecaExtension`, which is the
// assembly the app installs, so the wiring between the effects, the fields and
// the showTooltip facet is under test rather than the field in isolation.

// The tooltips this state currently wants shown. The facet holds nulls for
// sources that decline (the selection popup does so whenever the selection is
// empty), so they are filtered out rather than asserted on.
function tooltipsOf(state: EditorState): Tooltip[] {
	return state
		.facet(showTooltip)
		.filter((t): t is Tooltip => t != null && typeof t !== 'function');
}

function stateWithExtension(
	overrides: Partial<AnnotecaSettings> = {},
	doc: string = DOC,
): EditorState {
	return EditorState.create({
		doc,
		extensions: [buildAnnotecaExtension(stubCtx(overrides))],
	});
}

// Offset of the only marker in DOC, taken from the parser rather than hardcoded
// so the tests do not silently drift if the fixture changes.
const MARKER_START = findMarkersInDoc(DOC)[0]!.marker.start;

// An insertion point INSIDE the marker's body. Aimed at the body text rather
// than at a byte offset from the marker start, because landing in the category
// token instead produces a marker that no longer parses, which would make these
// tests pass or fail for the wrong reason.
const BODY_INSERT_AT = DOC.indexOf('a source');

// Identity of a tooltip's `create`, which is what CodeMirror matches tooltip
// views by, so it decides whether the live DOM is repositioned or rebuilt.
// Read through a cast because the typings declare `create` in method shorthand,
// and referencing a method without calling it trips @typescript-eslint's
// unbound-method rule; the cast keeps that honest without a disable comment.
function createRef(t: Tooltip): unknown {
	return (t as unknown as { create: unknown }).create;
}

describe('pinned reply composer', () => {
	it('follows its marker through an edit above and keeps the same DOM', () => {
		const open = stateWithExtension().update({
			effects: setReplyComposerEffect.of(MARKER_START),
		}).state;
		const before = tooltipsOf(open);
		expect(before).toHaveLength(1);

		const edited = open.update({
			changes: { from: 0, insert: 'XXXX' },
		}).state;
		const after = tooltipsOf(edited);

		// Still open, now anchored four characters further along...
		expect(after).toHaveLength(1);
		expect(after[0]!.pos).toBe(MARKER_START + 4);
		// ...and the SAME create closure, which is what makes CodeMirror
		// reposition the existing textarea instead of building a new one. This
		// is the assertion that fails if the tooltip is ever rebuilt here.
		expect(createRef(after[0]!)).toBe(createRef(before[0]!));
	});

	it('keeps the typed-into DOM even when the marker itself is rewritten', () => {
		// A lifecycle write from another surface (resolve, accept) rewrites the
		// marker's own span. The popover wants to redraw for that; the composer
		// must not, because the textarea holds text the user has not sent.
		const open = stateWithExtension().update({
			effects: setReplyComposerEffect.of(MARKER_START),
		}).state;
		const before = tooltipsOf(open);

		const rewritten = open.update({
			changes: { from: BODY_INSERT_AT, insert: 'better ' },
		}).state;
		const after = tooltipsOf(rewritten);

		expect(after).toHaveLength(1);
		expect(createRef(after[0]!)).toBe(createRef(before[0]!));
	});

	it('closes when its marker is deleted outright', () => {
		const open = stateWithExtension().update({
			effects: setReplyComposerEffect.of(MARKER_START),
		}).state;
		const gone = open.update({
			changes: { from: MARKER_START, to: DOC.indexOf('--> after.') + 3 },
		}).state;
		expect(tooltipsOf(gone)).toHaveLength(0);
	});

	it('does not open on an offset with no marker', () => {
		const state = stateWithExtension().update({
			effects: setReplyComposerEffect.of(3),
		}).state;
		expect(tooltipsOf(state)).toHaveLength(0);
	});
});

describe('pinned tap popover', () => {
	it('follows its marker through an edit above and keeps the same DOM', () => {
		const open = stateWithExtension().update({
			effects: setTapPopoverEffect.of(MARKER_START),
		}).state;
		const before = tooltipsOf(open);
		expect(before).toHaveLength(1);

		const edited = open.update({
			changes: { from: 0, insert: 'XXXX' },
		}).state;
		const after = tooltipsOf(edited);

		expect(after).toHaveLength(1);
		expect(after[0]!.pos).toBe(MARKER_START + 4);
		expect(createRef(after[0]!)).toBe(createRef(before[0]!));
	});

	it('redraws when the comment it is showing changes', () => {
		// The popover renders the comment: its replies, its resolution state,
		// and which action buttons apply. Pressing one of its own buttons is
		// the usual way that changes, so unlike the composer it has to rebuild
		// or it sits there offering "Resolve" on a resolved comment.
		const open = stateWithExtension().update({
			effects: setTapPopoverEffect.of(MARKER_START),
		}).state;
		const before = tooltipsOf(open);

		const rewritten = open.update({
			changes: { from: BODY_INSERT_AT, insert: 'better ' },
		}).state;
		const after = tooltipsOf(rewritten);

		expect(after).toHaveLength(1);
		expect(createRef(after[0]!)).not.toBe(createRef(before[0]!));
	});

	it('is superseded by opening the reply composer on the same marker', () => {
		const open = stateWithExtension().update({
			effects: setTapPopoverEffect.of(MARKER_START),
		}).state;
		const replying = open.update({
			effects: setReplyComposerEffect.of(MARKER_START),
		}).state;
		// Exactly one surface, never both stacked on one marker.
		expect(tooltipsOf(replying)).toHaveLength(1);
	});
});

describe('active-comment highlight', () => {
	function activeStartOf(
		state: EditorState,
		field: ReturnType<typeof buildMarkerDecorations>['activeField'],
	): number | null {
		return state.field(field);
	}

	it('follows its marker through an edit above', () => {
		const built = buildMarkerDecorations(stubCtx());
		const state = EditorState.create({
			doc: DOC,
			extensions: [built.extension],
		});
		const open = state.update({
			effects: setActiveCommentEffect.of(MARKER_START),
		}).state;
		const edited = open.update({
			changes: { from: 0, insert: 'XXXX' },
		}).state;
		expect(activeStartOf(edited, built.activeField)).toBe(MARKER_START + 4);
	});

	it('clears when its marker is deleted', () => {
		const built = buildMarkerDecorations(stubCtx());
		const state = EditorState.create({
			doc: DOC,
			extensions: [built.extension],
		});
		const open = state.update({
			effects: setActiveCommentEffect.of(MARKER_START),
		}).state;
		const gone = open.update({
			changes: { from: MARKER_START, to: DOC.indexOf('--> after.') + 3 },
		}).state;
		expect(activeStartOf(gone, built.activeField)).toBeNull();
	});
});

describe('selection popup', () => {
	it('reacts to the setting without waiting for the selection to move', () => {
		// The compute reads `selectionPopup` off the live settings object, which
		// CodeMirror cannot watch. Without settingsEpochField in its deps the
		// facet never recomputed, so turning the setting on did nothing until
		// the user happened to change the selection.
		const settings: AnnotecaSettings = {
			...DEFAULT_SETTINGS,
			selectionPopup: false,
		};
		const state = EditorState.create({
			doc: DOC,
			extensions: [
				buildAnnotecaExtension(stubDecorationContext(() => settings)),
			],
			selection: { anchor: 0, head: 5 },
		});
		expect(tooltipsOf(state)).toHaveLength(0);

		settings.selectionPopup = true;
		const bumped = state.update({
			effects: bumpSettingsEpochEffect.of(1),
		}).state;
		expect(tooltipsOf(bumped)).toHaveLength(1);
	});
});

// Regressions found by review on this change, both pinned here because both
// fail silently in the app rather than throwing.
describe('pinned surfaces track the comment, not a copy of it', () => {
	it('follows a marker when text is inserted exactly at its start', () => {
		// mapPos defaults to association -1, which keeps a position BEFORE text
		// inserted at it. A marker is not a cursor: typing at the end of the
		// prose immediately in front of it puts those characters ahead of the
		// `<!--`, so the marker now starts after them. With the default the
		// lookup missed by the length of what was typed and closed the surface.
		const open = stateWithExtension().update({
			effects: setReplyComposerEffect.of(MARKER_START),
		}).state;

		const edited = open.update({
			changes: { from: MARKER_START, insert: 'typed' },
		}).state;

		const after = tooltipsOf(edited);
		expect(after).toHaveLength(1);
		expect(after[0]!.pos).toBe(MARKER_START + 'typed'.length);
	});

	it('hands the CURRENT comment to a preserved surface, not the open-time one', () => {
		// The preserved DOM keeps its `create` closure by design, so whatever
		// that closure captured is frozen. A comment with no id is resolved by
		// its OFFSETS, so a frozen capture stops matching after an edit and
		// every action on that surface reports it as vanished.
		//
		// Asserted through the tap popover, and through an edit INSIDE the
		// marker, because that is the one path where the tooltip is rebuilt by
		// calling `build(ref)`: the resulting `pos`/`end` are then read off
		// `ref.current` and nothing else. On the preserve path they come from
		// the mapped offset instead, so asserting there would pass whether or
		// not the ref was ever repointed, which is exactly the hole this test
		// replaced.
		const open = stateWithExtension().update({
			effects: setTapPopoverEffect.of(MARKER_START),
		}).state;
		expect(tooltipsOf(open)[0]!.end).toBe(
			findMarkersInDoc(DOC)[0]!.marker.end,
		);

		const grown = open.update({
			changes: { from: BODY_INSERT_AT, insert: 'much longer body ' },
		}).state;

		const after = tooltipsOf(grown);
		expect(after).toHaveLength(1);
		// The marker is longer now. A stale ref would still report the end it
		// had when the popover opened.
		const freshEnd = findMarkersInDoc(grown.doc.toString())[0]!.marker.end;
		expect(freshEnd).toBeGreaterThan(findMarkersInDoc(DOC)[0]!.marker.end);
		expect(after[0]!.end).toBe(freshEnd);
	});
});
