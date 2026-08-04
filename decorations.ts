// CodeMirror 6 extension that decorates Annoteca markers in the editor and
// wires hover/click interactions back to the plugin. Implements F-031, F-032,
// F-033, F-034, F-037, F-038 from features.md.

import {
	Compartment,
	StateField,
	StateEffect,
	type EditorState,
	type Extension,
	type Range,
	type Transaction,
} from '@codemirror/state';
import {
	Decoration,
	EditorView,
	WidgetType,
	ViewPlugin,
	hoverTooltip,
	repositionTooltips,
	showTooltip,
	tooltips,
	type Tooltip,
} from '@codemirror/view';

import { Notice, setIcon, editorInfoField, type App } from 'obsidian';

import {
	renderReplyRow as renderSharedReplyRow,
	renderCategoryBadge,
	renderStarButton,
} from './ui-helpers';
import {
	renderCommentMarkdown,
	MarkdownLifetime,
	type MarkdownRenderHost,
} from './markdown-render';

import type { Comment } from './types';
import type { AnnotecaSettings, CategoryDefinition } from './types';
import { parseAll } from './parser';
import {
	planActiveCommentDecorations,
	resolveAnchorRangeInWindows,
	ANCHOR_WINDOW,
	shouldSubmitOnKeydown,
	formatStamp,
	truncate,
	replyCountLabel,
} from './view-utils';

export interface DecorationContext {
	// Needed by MarkdownRenderer to render comment bodies in the popover (#6).
	// This module otherwise touches Obsidian only for `setIcon`; carrying the
	// App on the context keeps that dependency explicit and injectable rather
	// than reaching for a global.
	app: App;
	// Fallback source path for resolving links in a rendered body, used only
	// when the editor cannot say which file it holds. Empty string when unknown,
	// which still renders, it just cannot resolve them. Prefer sourcePathFor,
	// which asks the view first.
	getSourcePath(): string;
	getSettings(): AnnotecaSettings;
	onMarkerClick(marker: Comment): void;
	addCommentForSelection(): void;
	categoryFor(id: string): CategoryDefinition;
	// Everything below that takes a `sourcePath` acts on a specific note, and
	// the popover is the only place it can come from (#22). A hover popover
	// does not activate the leaf it is anchored in, and clicking a button on it
	// does not either, so asking the workspace for the active file ran every
	// one of these against whichever note happened to be focused. `view` is in
	// scope wherever the popover is built, so each is `sourcePathFor(ctx, view)`.
	openInReviewer(marker: Comment, sourcePath: string): void;
	toggleResolution(marker: Comment, sourcePath: string): void;
	resolveAndRemove(marker: Comment, sourcePath: string): void;
	acceptAddressed(marker: Comment, sourcePath: string): void;
	reviseAddressed(marker: Comment, sourcePath: string): void;
	rejectAddressed(marker: Comment, sourcePath: string): void;
	copyPermalink(marker: Comment): void;
	// Resolves to whether the reply was actually written. The write can be
	// refused (the marker was deleted, or an id-less one changed underneath),
	// and the composer must not clear the draft or close on a refusal: the
	// draft is the only copy of what the user typed.
	submitReply(
		marker: Comment,
		body: string,
		author: string,
		// The file THIS editor holds. A popover in a non-active split pane must
		// write to its own note, not to whatever is focused.
		sourcePath: string,
	): Promise<boolean>;
	getAuthorTag(): string;
	getAuthorOptions(): string[];
	authorColor(tag: string): string | undefined;
	isStarred(marker: Comment): boolean;
	toggleStarred(marker: Comment): void;
	loadDraft(commentId: string): string;
	saveDraft(commentId: string, body: string): void;
	clearDraft(commentId: string): void;
}

// Module-level transient state. Editor open/close re-evaluates these. This
// stays the cross-editor source of truth (a newly opened editor adopts it in
// `hideAllField.create`, and `isHideAllComments` reads it for the toggle), but
// nothing that draws may read it directly. See `hideAllField`.
const hideAllFlag = { value: false };

export const setHideAllCommentsEffect = StateEffect.define<boolean>();

// The drawing code reads hide-all from THIS field, never from `hideAllFlag`.
// A CodeMirror facet only recomputes when one of its declared dependencies
// changes identity, so a decoration source that reads a module-level global is
// invisible to that machinery: flipping the global changed nothing CodeMirror
// tracked, and the comments stayed on screen until an unrelated document edit
// or selection move happened to recompute the facet for another reason.
// Mirroring the flag into a StateField makes it a real dependency, so the
// toggle repaints on its own transaction.
const hideAllField = StateField.define<boolean>({
	create() {
		return hideAllFlag.value;
	},
	update(value, tr) {
		// Effects only, so a state transition is a function of the transaction
		// and nothing else. Every live editor receives the effect (see
		// `setHideAllCommentsEverywhere`) and an editor opened later picks the
		// current value up in `create`, so there is no path that needs this to
		// consult the module flag.
		for (const e of tr.effects) {
			if (e.is(setHideAllCommentsEffect)) return e.value;
		}
		return value;
	},
});

// Inline comment bodies (#4). Deliberately the exact mirror of the hide-all
// pair above, including being module-global rather than per-view: the two
// commands are opposites, and scoping one per-pane while the other reaches
// every pane would give the user two adjacent toggles with different blast
// radius. Global also means a second pane on the same file shows bodies too,
// which is the behaviour a split-pane reader wants from a bird's-eye view.
const showBodiesFlag = { value: false };

export const setShowCommentBodiesEffect = StateEffect.define<boolean>();

// Same reasoning as `hideAllField`, and the same rule: the drawing code reads
// this field, never `showBodiesFlag`. A decoration source that reads a
// module-level global is invisible to CodeMirror's dependency tracking, so the
// toggle would appear to do nothing until an unrelated edit or click happened
// to recompute the facet for some other reason.
const showBodiesField = StateField.define<boolean>({
	create() {
		return showBodiesFlag.value;
	},
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setShowCommentBodiesEffect)) return e.value;
		}
		return value;
	},
});

// Settings epoch. Decoration drawing reads a lot of settings through
// `ctx.getSettings()`, which is a closure over the plugin's live object:
// CodeMirror cannot see when its contents change, so changing an editor
// indicator setting used to leave every open editor drawing the old one until
// an unrelated edit or click happened to recompute the facet. Measured in
// Obsidian 1.13.4: after saving, focusing the editor was not enough, only a
// click or a keystroke brought the new setting in.
//
// Bumping a counter that IS a declared dependency makes any settings change a
// real repaint trigger. The value is never read for its own sake; only its
// identity matters.
const settingsEpoch = { value: 0 };

export const bumpSettingsEpochEffect = StateEffect.define<number>();

const settingsEpochField = StateField.define<number>({
	create() {
		return settingsEpoch.value;
	},
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(bumpSettingsEpochEffect)) return e.value;
		}
		return value;
	},
});

// Reply composer state. The pinned tooltip below uses this to render a textarea
// at a specific marker. `null` means no composer is open. Exported so tests can
// open the surface without a live DOM, the same way the hide-all and
// show-bodies effects already are.
export const setReplyComposerEffect = StateEffect.define<number | null>();

// Tap-popover state. Carries the marker start of the comment whose popover is
// pinned open by a click, or `null` for none. Separate from the hover tooltip
// because that one is driven entirely by CodeMirror's pointer tracking and
// vanishes on mouse-out, which is exactly the behaviour a touch user cannot
// use.
export const setTapPopoverEffect = StateEffect.define<number | null>();

// Dismiss the pinned popover. Used by the popover's own actions that navigate
// away from it: the outside-click handler deliberately exempts clicks inside
// the popover, so without this the popover survives its own Open button and
// hangs over the panel it just opened, which on a phone means it covers the
// sidebar that was the whole point of pressing it.
function closeTapPopover(view: EditorView): void {
	view.dispatch({ effects: setTapPopoverEffect.of(null) });
}

// Active-comment state (F-276). Carries the marker start of the comment whose
// thread is currently open in the side panel, or `null` when nothing is
// selected. The plugin dispatches this when the panel focuses a comment and
// clears it when the panel closes; the StateField below paints a background
// over the active comment so the reviewer never loses track of which marker the
// thread belongs to. Mirrors the reply-composer effect/field pair.
export const setActiveCommentEffect = StateEffect.define<number | null>();

// Dispatch the active-comment highlight into a specific editor. `null` clears
// it. Called from main.ts on panel focus / close.
export function setActiveComment(
	view: EditorView,
	markerStart: number | null,
): void {
	view.dispatch({ effects: setActiveCommentEffect.of(markerStart) });
}

// Every editor this extension is currently installed in. The workspace can only
// enumerate markdown leaves, which misses embedded editors such as Canvas
// cards, so asking Obsidian for the inventory always undercounts. Each view
// registers itself for its own lifetime instead, which is exact by
// construction.
const liveViews = new Set<EditorView>();

const trackLiveView = ViewPlugin.fromClass(
	class {
		constructor(private readonly view: EditorView) {
			liveViews.add(view);
		}
		destroy(): void {
			liveViews.delete(this.view);
		}
	},
);

// Hide-all is one switch for every editor, so the toggle reaches all of them
// rather than only the focused pane. Iterating a copy because dispatching can
// in principle tear a view down, which would mutate the set mid-iteration.
export function setHideAllCommentsEverywhere(hide: boolean): void {
	hideAllFlag.value = hide;
	for (const view of [...liveViews]) {
		view.dispatch({ effects: setHideAllCommentsEffect.of(hide) });
	}
}

export function isHideAllComments(): boolean {
	return hideAllFlag.value;
}

// Inline bodies are one switch for every editor too, for the reasons on
// `showBodiesFlag`. Same copy-the-set guard as hide-all: dispatching can in
// principle tear a view down, which would mutate the set mid-iteration.
export function setShowCommentBodiesEverywhere(show: boolean): void {
	showBodiesFlag.value = show;
	for (const view of [...liveViews]) {
		view.dispatch({ effects: setShowCommentBodiesEffect.of(show) });
	}
}

export function isShowingCommentBodies(): boolean {
	return showBodiesFlag.value;
}

// Why inline comment bodies would not be drawn right now, or `null` if they
// would be.
//
// This lives beside `decorationsCompute` on purpose. The toggle command has to
// know whether pressing it would produce anything visible, and the first two
// attempts had the command enumerate the drawing code's gates for itself. That
// list grew twice in review (indicator style, then hide-all) and would have
// kept growing, because nothing tied the two copies together. Answering the
// question here means a new early return in the compute cannot be added
// without this moving with it.
//
// Per-marker conditions (a resolved comment the user hides, an empty body) are
// deliberately NOT here: a document can hold a mix, so they are not something
// a document-wide command can refuse on.
export type InlineBodiesBlocker = 'hide-all' | 'no-icon';

// The one definition of "this style draws a marker icon". `decorationsCompute`
// and `inlineBodiesBlockedBy` both need it, and writing it twice in opposite
// polarity was the exact drift the paragraph above warns about, one level down.
function stylesShowIcon(style: AnnotecaSettings['indicatorStyle']): boolean {
	return style === 'icon' || style === 'both';
}

export function inlineBodiesBlockedBy(
	settings: AnnotecaSettings,
): InlineBodiesBlocker | null {
	if (isHideAllComments()) return 'hide-all';
	if (!stylesShowIcon(settings.indicatorStyle)) return 'no-icon';
	return null;
}

// Called from `saveSettings`, so every editor picks up a settings change at the
// moment it is made rather than at the next unrelated interaction. See
// `settingsEpochField` for why a plain settings write is invisible to
// CodeMirror.
export function refreshDecorationsEverywhere(): void {
	settingsEpoch.value += 1;
	for (const view of [...liveViews]) {
		view.dispatch({
			effects: bumpSettingsEpochEffect.of(settingsEpoch.value),
		});
	}
}

const markerStateField = (_ctx: DecorationContext) =>
	StateField.define<Comment[]>({
		create(state) {
			return parseAll(state.doc.toString());
		},
		update(value, tr: Transaction) {
			// The parsed markers depend on the document and nothing else. This
			// used to also branch on the hide-all effect, but both branches
			// returned the existing value unchanged, so it read as if hide-all
			// were handled here when it did nothing at all. Visibility is
			// `hideAllField`'s job.
			if (!tr.docChanged) return value;
			return parseAll(tr.state.doc.toString());
		},
	});

class MarkerIconWidget extends WidgetType {
	constructor(
		private readonly marker: Comment,
		private readonly hidden: boolean,
		private readonly showReplyCount: boolean,
		// Takes the view because the click may need to dispatch an effect into
		// it (pinning the tap popover) rather than only calling out to the
		// plugin. toDOM receives the view, so it is available at bind time.
		private readonly onClick: (marker: Comment, view: EditorView) => void,
	) {
		super();
	}

	override eq(other: WidgetType): boolean {
		if (!(other instanceof MarkerIconWidget)) return false;
		const o = other.marker;
		const m = this.marker;
		return (
			o.marker.start === m.marker.start &&
			o.marker.end === m.marker.end &&
			o.category === m.category &&
			o.body === m.body &&
			// Defence in depth, not a bug fix. Replies are serialized INTO the
			// marker (parser.ts), so adding one grows the marker text and
			// `end` above already differs; a widget carrying a stale count
			// cannot survive a repaint today. Comparing the count directly
			// stops that from resting on a coincidence of the file format.
			o.replies.length === m.replies.length &&
			o.resolution === m.resolution &&
			o.addressed === m.addressed &&
			other.hidden === this.hidden &&
			// This one IS load-bearing: turning the setting off changes what
			// the widget draws while every marker range stays identical, so
			// without it the badge survives its own setting.
			other.showReplyCount === this.showReplyCount
		);
	}

	override toDOM(view: EditorView): HTMLElement {
		const el = view.dom.ownerDocument.win.createSpan();
		el.className = `annoteca-icon annoteca-cat-${this.marker.category}`;
		el.setAttribute(
			'data-annoteca-marker-start',
			String(this.marker.marker.start),
		);
		el.setAttribute(
			'data-annoteca-marker-end',
			String(this.marker.marker.end),
		);
		if (this.marker.resolution) el.classList.add('annoteca-resolved');
		// F-270: an addressed comment (pending accept/revise/reject) gets a
		// distinct accent so the reviewer sees at a glance which markers the AI
		// has acted on. Resolved wins visually if somehow both are present.
		if (this.marker.addressed && !this.marker.resolution)
			el.classList.add('annoteca-addressed');
		if (this.hidden) el.classList.add('annoteca-resolved-hidden');
		const replies = this.marker.replies.length;
		if (replies > 0) el.classList.add('annoteca-has-replies');
		const countSuffix =
			replies > 0 && this.showReplyCount
				? ` (${replyCountLabel(replies)})`
				: '';
		el.title = `${this.marker.category}: ${this.marker.body.slice(0, 80)}${countSuffix}`;
		// The same glyph for every marker STATE. Resolved status is conveyed
		// via the annoteca-resolved CSS class (opacity + strikethrough), not
		// a different character — switching shapes (◆ vs ●) at small font
		// sizes reads as visual noise rather than meaningful state. The reply
		// count below appends to this rather than varying it, which is the
		// same rule and not an exception to it.
		el.textContent = '◆';
		// Thread size on the marker. Appended AFTER textContent, which
		// replaces children. Honors the single-glyph reasoning above by
		// staying a superscript digit rather than a pill badge, and by
		// rendering nothing at zero replies, since a "0" on every solitary
		// comment is exactly the visual noise that rule exists to prevent.
		//
		// aria-hidden because it is a compact restatement of the count the
		// title above already gives in words; a screen reader announcing
		// "◆2" is worse than announcing "clarify: ... (2 replies)".
		if (replies > 0 && this.showReplyCount) {
			el.classList.add('annoteca-has-reply-count');
			el.createSpan({
				cls: 'annoteca-reply-count',
				text: String(replies),
				attr: { 'aria-hidden': 'true' },
			});
		}
		// Handle the click on the widget directly. A replaced widget that returns
		// true from ignoreEvent does NOT route its clicks to the editor's
		// domEventHandlers, so the icon would otherwise be unclickable (point
		// comments, which have only an icon and no underline, could not be opened
		// at all). The anchor underline is plain marked text and still goes
		// through the editor click handler. stopPropagation prevents a double
		// open if the event ever does bubble.
		el.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onClick(this.marker, view);
		});
		return el;
	}

	override ignoreEvent(event: Event): boolean {
		// Keep CM6 from treating a press on the icon as cursor placement (which
		// would move the cursor into the marker range). The icon handles its own
		// click via the listener in toDOM, so we do not depend on CM routing the
		// click to domEventHandlers (it does not, for a widget that ignores it).
		if (event.type === 'mousedown' || event.type === 'click') return true;
		return false;
	}
}

// Cap for the inline body (#4). A body can run to many paragraphs, and what
// was asked for is a bird's-eye view, so an untruncated body inline would
// wreck the layout of the document it is meant to annotate. 80 matches the
// slice the marker tooltip already uses, so the two surfaces agree on how much
// of a body is "enough".
const INLINE_BODY_MAX = 80;

// One line of plain text for an inline body. Whitespace is collapsed BEFORE
// truncating, so the cap counts characters the reader actually sees and a
// multi-line body cannot push the surrounding prose around.
function inlineBodyText(body: string): string {
	return truncate(body.replace(/\s+/g, ' ').trim(), INLINE_BODY_MAX);
}

// The comment body drawn beside its marker when show-all is on (#4). Plain
// text on purpose, and it must STAY plain when markdown rendering lands:
// headings and lists repeated at every marker would destroy the document view,
// which is the opposite of the bird's-eye view being asked for.
class InlineBodyWidget extends WidgetType {
	constructor(
		private readonly text: string,
		private readonly category: string,
		private readonly resolved: boolean,
	) {
		super();
	}

	override eq(other: WidgetType): boolean {
		return (
			other instanceof InlineBodyWidget &&
			other.text === this.text &&
			other.category === this.category &&
			other.resolved === this.resolved
		);
	}

	override toDOM(view: EditorView): HTMLElement {
		const el = view.dom.ownerDocument.win.createSpan();
		el.className = `annoteca-inline-body annoteca-cat-${this.category}`;
		if (this.resolved) el.classList.add('annoteca-resolved');
		el.textContent = this.text;
		return el;
	}
}

// Locate the doc range matching the stored anchor text (F-273: direction-
// agnostic). Searches both immediately before the marker (legacy end-placement)
// and immediately after it (begin-placement) and underlines whichever side
// resolves. Returns null when the marker has no anchor or neither side matches.
//
// Truncated anchors are matched in two halves around the U+2026 ellipsis so the
// underline covers everything the comment is about, including prose the
// truncation skipped. The string-matching logic lives in
// resolveAnchorRangeInWindows (view-utils.ts) and is unit-tested there; this
// wrapper slices the CM windows so the whole document is never materialized.
function findAnchorRange(
	doc: import('@codemirror/state').Text,
	m: Comment,
): { from: number; to: number } | null {
	const a = m.anchor;
	if (!a) return null;
	const text = a.text;
	if (text.length === 0) return null;

	const markerStart = m.marker.start;
	const markerEnd = m.marker.end;
	const backStart = Math.max(0, markerStart - ANCHOR_WINDOW);
	const preceding = doc.sliceString(backStart, markerStart);
	const following = doc.sliceString(
		markerEnd,
		Math.min(doc.length, markerEnd + ANCHOR_WINDOW),
	);

	return resolveAnchorRangeInWindows(
		preceding,
		backStart,
		markerStart,
		following,
		markerEnd,
		text,
	);
}

function anchorClassesFor(c: Comment, settings: AnnotecaSettings): string {
	const tier = resolveTier(c.category, settings);
	const classes = [
		'annoteca-anchor',
		`annoteca-cat-${c.category}`,
		`annoteca-anchor-tier-${tier}`,
	];
	if (c.resolution) classes.push('annoteca-resolved');
	return classes.join(' ');
}

function resolveTier(
	categoryId: string,
	settings: AnnotecaSettings,
): 'subtle' | 'normal' | 'strong' {
	const def = settings.categories.find((c) => c.id === categoryId);
	return def?.tier ?? 'normal';
}

function decorationsCompute(
	ctx: DecorationContext,
	field: StateField<Comment[]>,
): Extension {
	const deps = [
		field,
		hideAllField,
		showBodiesField,
		settingsEpochField,
		'selection' as const,
	];
	return EditorView.decorations.compute(deps, (state) => {
		if (state.field(hideAllField)) return Decoration.none;
		const markers = state.field(field);
		const settings = ctx.getSettings();
		if (settings.indicatorStyle === 'none') return Decoration.none;

		const showBodies = state.field(showBodiesField);

		const showIcon = stylesShowIcon(settings.indicatorStyle);
		const showUnderline =
			settings.indicatorStyle === 'underline' ||
			settings.indicatorStyle === 'both';

		// Build a list sorted by start, since RangeSetBuilder requires monotone
		// order. parseAll returns markers in document order already, but sort
		// defensively in case the parser ever changes.
		const sorted = [...markers].sort(
			(a, b) => a.marker.start - b.marker.start,
		);

		// Two streams of decorations: anchor underlines (Decoration.mark, can
		// start before the marker) and marker icons (Decoration.replace at the
		// marker range itself). They go into the same sorted output but the
		// underline is emitted first when it starts earlier — CM6 requires
		// monotone start order.
		const decorations: Range<Decoration>[] = [];

		for (const m of sorted) {
			const isHidden =
				m.resolution !== undefined &&
				settings.resolvedDisplay === 'hide';

			// Anchor underline is suppressed entirely when the comment is
			// resolved and the user picked "hide" — they want resolved noise
			// gone, not faded.
			if (showUnderline && !isHidden) {
				const range = findAnchorRange(state.doc, m);
				if (range && range.from < range.to) {
					decorations.push(
						Decoration.mark({
							class: anchorClassesFor(m, settings),
							attributes: {
								'data-annoteca-anchor-for': String(
									m.marker.start,
								),
							},
						}).range(range.from, range.to),
					);
				}
			}

			if (!showIcon) continue;

			// Always render the marker as the atomic icon widget. The raw
			// HTML-comment text is never surfaced inline — users edit through
			// the modal (right-click → Edit comment, or the popup's Edit
			// button). When resolvedDisplay is "hide" and the comment is
			// resolved, the widget still replaces the marker range (so the
			// raw HTML doesn't leak) but renders display: none.
			decorations.push(
				Decoration.replace({
					widget: new MarkerIconWidget(
						m,
						isHidden,
						settings.markerReplyCount,
						(marker, view) => activateMarker(ctx, view, marker),
					),
					inclusive: false,
				}).range(m.marker.start, m.marker.end),
			);

			// Inline body (#4), drawn immediately after the icon it belongs
			// to. Reached only when the icon is drawn, which is why the
			// command refuses to toggle in the two styles that skip it. In
			// "underline" style the marker range is never replaced, so its raw
			// `<!-- annoteca/... -->` text, which contains the body, is
			// already on screen (measured in Obsidian 1.13.4) and a truncated
			// second copy beside it would be pure noise. In "none" style
			// nothing is drawn at all.
			//
			// Skipped for a resolved comment the user has chosen to hide: the
			// icon is rendered display:none in that case, and a body floating
			// beside an invisible marker is worse than nothing.
			if (showBodies && !isHidden) {
				const text = inlineBodyText(m.body);
				if (text.length > 0) {
					decorations.push(
						Decoration.widget({
							widget: new InlineBodyWidget(
								text,
								m.category,
								m.resolution !== undefined,
							),
							side: 1,
						}).range(m.marker.end),
					);
				}
			}
		}
		return Decoration.set(decorations, true);
	});
}

// --------------------------------------------------------------------------
// Hover popup: full conversation + action buttons.
// --------------------------------------------------------------------------

const MAX_REPLIES_IN_POPUP = 3;

// Tint an author label with its configured color (F-275). Uses a CSS variable
// the .annoteca-author rule consumes, set programmatically (like the category
// color dots), so no per-author static CSS is needed for a dynamic tag set.
function applyAuthorColor(
	el: HTMLElement,
	tag: string,
	ctx: DecorationContext,
): void {
	const color = ctx.authorColor(tag);
	if (!color) return;
	el.addClass('annoteca-author');
	el.style.setProperty('--annoteca-author-color', color);
}

// Hover-popup class names for the shared reply-row renderer (ui-helpers). The
// Thread tab passes its own; both go through one implementation.
const HOVER_REPLY_CLASSES = {
	row: 'annoteca-hover-reply',
	meta: 'annoteca-hover-reply-head',
	author: 'annoteca-hover-reply-author',
	date: 'annoteca-hover-reply-date',
	body: 'annoteca-hover-reply-body',
};

function renderReplyRow(
	reply: { author: string; date: string; body: string },
	parent: HTMLElement,
	ctx: DecorationContext,
	host: MarkdownRenderHost,
): void {
	renderSharedReplyRow(
		parent,
		reply,
		HOVER_REPLY_CLASSES,
		(el, tag) => applyAuthorColor(el, tag, ctx),
		host,
	);
}

// Hover dwell presets (ms) keyed by the hoverDelay setting, mirroring the
// indicatorSize size map. Read once when the extension is built; changing the
// setting takes effect on the next plugin reload.
const HOVER_DELAY_MS: Record<AnnotecaSettings['hoverDelay'], number> = {
	instant: 0,
	short: 150,
	default: 300,
	relaxed: 600,
};

// The file THIS editor holds, which is not necessarily the active one. Hovering
// a marker in a split pane does not activate that leaf, so asking the workspace
// for the active file resolves a body's relative links and wikilinks against
// whichever note happens to be focused, quietly pointing them at the wrong note.
// The editor itself knows, via the state field Obsidian installs on every
// markdown editor. `false` makes the lookup optional, for a state built without
// it (the unit tests build bare CodeMirror states).
function sourcePathFor(ctx: DecorationContext, view: EditorView): string {
	const info = view.state.field(editorInfoField, false);
	return info?.file?.path ?? ctx.getSourcePath();
}

// `instanceof` is realm-bound: it compares against the constructor belonging to
// the window this module was loaded into. Tooltips mount in their own editor's
// window (see `perWindowTooltipHost`), so in a popout every element making up a
// popover comes from a different realm and an `instanceof HTMLElement` guard is
// false for all of them, silently disabling whatever it protects. `nodeType` is
// data rather than a constructor, so it survives the crossing.
//
// Deliberately `Element`, not `HTMLElement`: nodeType 1 is any element, and the
// popover really does contain SVG (setIcon builds it), so a click target can be
// an SVGElement. Both call-site needs, `addClass` and `closest`, are Element
// members, so widening the guard costs nothing and claiming `HTMLElement` here
// would be an unsound predicate.
function isElementAcrossRealms(t: unknown): t is Element {
	return (
		t instanceof Element ||
		(t != null &&
			typeof t === 'object' &&
			(t as Partial<Node>).nodeType === 1)
	);
}

// A tooltip mount point that follows its editor's window ---------------------
//
// Without a `parent`, CodeMirror mounts tooltips inside `view.dom`, which is
// not usable in Obsidian: `.workspace-leaf` is `contain: strict`, making the
// leaf the containing block for `position: fixed` descendants AND paint-
// clipping them to it. Verified in the running app rather than reasoned about:
// a fixed element appended inside `.cm-editor` reports its origin at the leaf's
// corner, and `elementFromPoint` just past the leaf edge does not hit it. A
// parentless popover in a narrow sidebar leaf is therefore not merely squeezed,
// it is cut off.
//
// The override this replaces passed `parent: activeDocument.body`, evaluated
// ONCE when the plugin loaded. That is one element for the whole app, so every
// editor's tooltips went to whichever window was active at load time: a popout
// window got no popover UI at all, and reloading while a popout was focused
// broke the main window instead.
//
// `tooltips({parent})` is a state facet, so the parent cannot be a function of
// the view, and it cannot be re-pointed after the fact either: `tooltipConfig`
// combines by taking the FIRST value carrying a parent, and anything appended
// to a state's configuration lands last. What CAN change is the element itself.
// So each view gets its own host and the host is moved into whichever window
// the editor currently lives in.
//
// Moving it must work at any moment, because Obsidian re-parents the SAME
// EditorView into the popout when a leaf is moved to a new window (verified:
// the instance is identical afterwards, only `ownerDocument` differs). That is
// why the host is a DOM move rather than a reconfiguration: it needs no
// transaction, and CodeMirror's own container sits inside the host, so the live
// tooltips travel with it instead of being stranded in the old window.
// Holds the per-view `tooltips({parent})`. A compartment rather than
// `StateEffect.appendConfig`, and the difference is not cosmetic: appended
// extensions ACCUMULATE, and `tooltipConfig` combines by taking the FIRST value
// carrying a parent, so once a host had been appended it won for the life of
// that state. Re-enabling the plugin with a note open therefore left the
// container inside the PREVIOUS generation's host, which `destroy()` had already
// removed from the document, and every popover in that editor went into a
// detached element. Verified in the running app before this was a compartment:
// the live host sat empty and no later transaction recovered it.
//
// `reconfigure` replaces the compartment's contents instead of adding to them,
// and the compartment sits in the extension array below, ahead of anything
// appended, so it also wins over any stale appended value from an older build.
const tooltipParentCompartment = new Compartment();

function perWindowTooltipHost(): Extension {
	return ViewPlugin.fromClass(
		class {
			private readonly view: EditorView;
			private readonly host: HTMLElement;
			private destroyed = false;
			private pending = false;

			constructor(view: EditorView) {
				this.view = view;
				this.host = view.dom.ownerDocument.win.createDiv({
					cls: 'annoteca-tooltip-host',
				});
				this.moveHostToOwnWindow();
				this.claimHost();
			}

			update(): void {
				this.moveHostToOwnWindow();
				this.claimHost();
			}

			destroy(): void {
				this.destroyed = true;
				this.host.remove();
			}

			// Point this view's tooltips at our host, and keep doing it for as
			// long as it does not stick.
			//
			// It has to be re-applied, not set once. The parent is added with
			// `StateEffect.appendConfig`, and a full reconfiguration of the
			// state replaces the configuration outright, taking every appended
			// extension with it. Obsidian reconfigures editors whenever
			// `workspace.updateOptions()` runs, which includes re-enabling the
			// plugin with notes already open, and this ViewPlugin survives that
			// reconfiguration rather than being rebuilt. Verified in the running
			// app: after a disable/enable cycle the host existed but was empty,
			// and no later transaction healed it, so every popover in that
			// editor was mounting back inside the leaf and being clipped by it.
			//
			// CodeMirror appends its own container to the parent as soon as the
			// config takes, and leaves it there, so an empty host is an exact
			// signal that the parent is not currently in effect. Checking that
			// on every update costs one property read and makes the repair
			// automatic whenever a reconfiguration drops it.
			private claimHost(): void {
				if (this.destroyed || this.pending || this.host.firstChild)
					return;
				this.pending = true;
				// A dispatch cannot happen inside a view update, and this runs
				// from both the constructor and update(). A timeout puts it
				// after the current cycle in every case.
				this.view.dom.win.setTimeout(() => {
					this.pending = false;
					if (this.destroyed || this.host.firstChild) return;
					this.view.dispatch({
						effects: tooltipParentCompartment.reconfigure(
							tooltips({ parent: this.host }),
						),
					});
				}, 0);
			}

			// Cheap enough to run on every update, which is what makes the
			// popout move self-correcting without listening for it: the first
			// transaction in the new window puts the host there, and opening a
			// popover is itself a transaction.
			private moveHostToOwnWindow(): void {
				const body = this.view.dom.ownerDocument.body;
				if (this.host.parentElement === body) return;
				body.appendChild(this.host);
			}
		},
	);
}

// Builds the comment popover DOM. Extracted from the hover tooltip so the
// tap-anchored popover renders the identical surface instead of a second,
// drifting copy: every action here (accept, revise, reject, star, reply,
// resolve, copy id, open) has to behave the same whichever way it was opened.
//
// Takes `view` rather than a document because it needs the editor window for
// element creation and dispatches the reply-composer effect back into it.
//
// Returns a destroy hook alongside the DOM: CodeMirror calls it when the
// tooltip goes away, and it unloads the render lifetime below.
function buildCommentPopover(
	ctx: DecorationContext,
	view: EditorView,
	ref: CommentRef,
): { dom: HTMLElement; destroy: () => void } {
	// The comment as it stands now, for everything this function draws. The
	// action callbacks below fire later and read `ref.current` instead: the
	// pinned popover keeps this DOM across edits that only move the marker, and
	// an id-less comment is resolved by its offsets, so acting on the open-time
	// copy would be refused as "vanished".
	const m = ref.current;
	// One lifetime per popover instance. Whatever a rendered body creates
	// (embeds, code-block processors, another plugin's post-processor) hangs off
	// this and is unloaded when CodeMirror destroys the tooltip. A popover is
	// ephemeral (the hover one dismisses on mouse-out), so anything longer-lived
	// than the tooltip would accumulate for as long as the vault stays open.
	const lifetime = new MarkdownLifetime();
	lifetime.load();
	// The note THIS popover belongs to. Resolves links in a rendered body, and
	// is also what every lifecycle action below writes to, so an action taken on
	// a popover in an unfocused split hits that split's note (#22).
	const sourcePath = sourcePathFor(ctx, view);
	const host: MarkdownRenderHost = {
		app: ctx.app,
		component: lifetime,
		sourcePath,
		enabled: ctx.getSettings().renderMarkdownBodies,
		// MarkdownRenderer.render is async, but a CodeMirror tooltip measures and
		// positions itself synchronously right after create() returns. So the
		// tooltip is placed around an empty box and the content lands afterwards,
		// leaving it mis-sized and, above the anchor, visibly out of place.
		// repositionTooltips is CodeMirror's own answer for exactly this: content
		// that changed outside a view update.
		onRendered: () => repositionTooltips(view),
	};
	const dom = view.dom.ownerDocument.win.createDiv();
	dom.addClass('annoteca-hover-preview');
	// Tag the .cm-tooltip so styles.css strips the default frame. In practice
	// CodeMirror puts that class on THIS element rather than on a wrapper, so
	// closest() matches self and both classes end up on one node. That is why
	// `.cm-tooltip.annoteca-hover-preview` exists in styles.css: the frame-
	// stripping rule is a two-class selector on the same element and would
	// otherwise win against the popover's own sizing. closest() rather than
	// parentElement so this still works if CodeMirror ever does wrap it.
	queueMicrotask(() => {
		const tip = dom.closest('.cm-tooltip');
		if (isElementAcrossRealms(tip)) tip.addClass('annoteca-hover-tooltip');
	});

	const header = dom.createDiv({
		cls: 'annoteca-hover-header',
	});
	renderCategoryBadge(header, ctx.categoryFor(m.category), {
		badge: 'annoteca-hover-category',
	});
	if (m.resolution) {
		header.createSpan({
			cls: 'annoteca-hover-state',
			text: 'resolved',
		});
	} else if (m.addressed) {
		header.createSpan({
			cls: 'annoteca-hover-state annoteca-hover-state-addressed',
			text: 'addressed',
		});
	}
	if (m.date) {
		header.createSpan({
			cls: 'annoteca-hover-date',
			text: formatStamp(m.date),
		});
	}
	if (m.author) {
		const authorEl = header.createSpan({
			cls: 'annoteca-hover-author',
			text: m.author,
		});
		applyAuthorColor(authorEl, m.author, ctx);
	}

	// Star toggle pinned to the far right via margin-left: auto in CSS.
	// reflectInPlace: the hover popup is ephemeral, so it flips the
	// star itself rather than waiting for a panel re-render.
	renderStarButton(header, {
		cls: 'annoteca-hover-star',
		hasId: Boolean(m.id),
		starred: Boolean(m.id) && ctx.isStarred(m),
		onToggle: () => ctx.toggleStarred(ref.current),
		reflectInPlace: true,
	});

	renderCommentMarkdown(
		dom.createDiv({ cls: 'annoteca-hover-body' }),
		m.body,
		host,
	);

	const repliesCount = m.replies.length;
	if (repliesCount > 0) {
		const repliesBlock = dom.createDiv({
			cls: 'annoteca-hover-replies-list',
		});
		const shown = m.replies.slice(-MAX_REPLIES_IN_POPUP);
		const earlier = repliesCount - shown.length;
		if (earlier > 0) {
			const more = repliesBlock.createEl('button', {
				cls: 'annoteca-hover-more-link',
				text: `+${earlier} earlier ${earlier === 1 ? 'reply' : 'replies'} — open in side panel`,
			});
			more.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				closeTapPopover(view);
				ctx.openInReviewer(ref.current, sourcePath);
			});
		}
		for (const r of shown) renderReplyRow(r, repliesBlock, ctx, host);
	}

	// F-270/F-271/F-272: the addressed note, plus the verbatim original
	// when the edit replaced prose. The original is labeled "original
	// (replaced)" when the stored anchor no longer matches the document
	// (the expected post-replace state), and "original" otherwise.
	if (m.addressed) {
		const block = dom.createDiv({
			cls: 'annoteca-hover-addressed',
		});
		const head = block.createDiv({
			cls: 'annoteca-hover-resolution-head',
		});
		head.createSpan({
			cls: 'annoteca-hover-reply-author',
			text: m.addressed.author,
		});
		head.createSpan({
			cls: 'annoteca-hover-reply-date',
			text: formatStamp(m.addressed.date),
		});
		if (m.addressed.note) {
			renderCommentMarkdown(
				block.createDiv({ cls: 'annoteca-hover-reply-body' }),
				m.addressed.note,
				host,
			);
		}
		if (m.addressed.original !== undefined) {
			const anchorResolves = findAnchorRange(view.state.doc, m) !== null;
			const label = anchorResolves ? 'original' : 'original (replaced)';
			const orig = block.createDiv({
				cls: 'annoteca-hover-original',
			});
			orig.createDiv({
				cls: 'annoteca-hover-original-label',
				text: label,
			});
			// Stays plain text even with rendering on. This is the verbatim prose
			// Reject would splice back into the document, so it has to be shown as
			// what would be restored, not as what that text renders to. Formatting
			// it would hide the difference between `**bold**` and bold.
			orig.createDiv({
				cls: 'annoteca-hover-original-body',
				text: m.addressed.original,
			});
		}
	}

	if (m.resolution && m.resolution.note) {
		const block = dom.createDiv({
			cls: 'annoteca-hover-resolution',
		});
		const head = block.createDiv({
			cls: 'annoteca-hover-resolution-head',
		});
		head.createSpan({
			cls: 'annoteca-hover-reply-author',
			text: m.resolution.author,
		});
		head.createSpan({
			cls: 'annoteca-hover-reply-date',
			text: formatStamp(m.resolution.date),
		});
		renderCommentMarkdown(
			block.createDiv({ cls: 'annoteca-hover-reply-body' }),
			m.resolution.note,
			host,
		);
	}

	const actions = dom.createDiv({
		cls: 'annoteca-hover-actions',
	});

	// F-270: an addressed comment gets accept / revise / reject in
	// place of the plain resolve actions. Accept resolves it, revise
	// returns it to open for further editing, reject reverts the prose.
	if (m.addressed) {
		const acceptBtn = actions.createEl('button', {
			cls: 'annoteca-hover-action mod-cta',
			text: 'Accept',
		});
		acceptBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			ctx.acceptAddressed(ref.current, sourcePath);
		});
		const reviseBtn = actions.createEl('button', {
			cls: 'annoteca-hover-action',
			text: 'Revise',
		});
		reviseBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			ctx.reviseAddressed(ref.current, sourcePath);
		});
		const rejectBtn = actions.createEl('button', {
			cls: 'annoteca-hover-action',
			text: 'Reject',
		});
		rejectBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			ctx.rejectAddressed(ref.current, sourcePath);
		});
	}

	const openBtn = actions.createEl('button', {
		cls: 'annoteca-hover-action',
		text: 'Open in side panel',
	});
	openBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		closeTapPopover(view);
		ctx.openInReviewer(ref.current, sourcePath);
	});

	const replyBtn = actions.createEl('button', {
		cls: 'annoteca-hover-action',
		text: 'Reply',
	});
	replyBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		view.dispatch({
			effects: setReplyComposerEffect.of(ref.current.marker.start),
		});
	});

	if (!m.addressed) {
		const resolveBtn = actions.createEl('button', {
			cls: 'annoteca-hover-action',
			text: m.resolution ? 'Reopen' : 'Resolve',
		});
		resolveBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			ctx.toggleResolution(ref.current, sourcePath);
		});

		if (!m.resolution) {
			const resolveRemoveBtn = actions.createEl('button', {
				cls: 'annoteca-hover-action',
				text: 'Resolve and remove',
			});
			resolveRemoveBtn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				ctx.resolveAndRemove(ref.current, sourcePath);
			});
		}
	}

	if (m.id) {
		const copyBtn = actions.createEl('button', {
			cls: 'annoteca-hover-action',
			text: 'Copy ID',
		});
		copyBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			ctx.copyPermalink(ref.current);
		});
	}

	// A rendered body can contain links. Following one navigates the workspace,
	// which would otherwise leave a pinned popover hanging over the note the user
	// just arrived at: clickKeepsTapPopover exempts everything inside
	// .annoteca-hover-preview, and that exemption is what keeps the popover alive
	// while a reply is being typed, so it cannot simply be narrowed.
	dom.addEventListener('click', (e) => {
		const target = e.target;
		if (isElementAcrossRealms(target) && target.closest('a')) {
			closeTapPopover(view);
		}
	});

	return { dom, destroy: () => lifetime.unload() };
}

function hoverTooltipExtension(
	ctx: DecorationContext,
	field: StateField<Comment[]>,
): Extension {
	return hoverTooltip(
		(view, pos): Tooltip | null => {
			if (view.state.field(hideAllField)) return null;
			// In popover mode the hover preview is off, and not merely
			// suppressed while one is pinned. The two render the identical
			// surface, so on a pointer device a dwell followed by a click
			// stacks two copies on the same marker. Guarding only on "a popover
			// is currently pinned" does not fix that: CodeMirror owns the hover
			// tooltip's lifetime and does not re-consult this source for an
			// unrelated effect, so an already-open hover tooltip would survive
			// the click and sit behind the pinned one until mouse-out.
			//
			// Turning hover off outright is also the coherent reading of the
			// setting. Choosing "Show popover" says the click is how comments
			// get opened, and the popover is exactly the hover preview, pinned.
			const settings = ctx.getSettings();
			if (settings.markerClickAction === 'popover') return null;
			if (!settings.hoverPreview) return null;
			if (settings.indicatorStyle === 'none') return null;
			const markers = view.state.field(field);

			// Hover hits the marker range (where the inline icon lives).
			let m = markers.find(
				(c) => pos >= c.marker.start && pos <= c.marker.end,
			);
			// Track the actual hovered range so the tooltip's source matches where
			// the mouse really is. If we report the marker range while the user is
			// actually over the anchor underline, CodeMirror dismisses the tooltip
			// the moment the mouse moves because it thinks the mouse already left
			// the source range — breaking the keepalive that lets users traverse
			// onto the popup.
			let hoverRange: { from: number; to: number } | undefined = m
				? { from: m.marker.start, to: m.marker.end }
				: undefined;

			// Also accept hover anywhere over the anchor underline. The underline
			// sits before the marker range, so the marker-range find above misses
			// it. Only check when the underline is actually being rendered.
			if (
				!m &&
				(settings.indicatorStyle === 'underline' ||
					settings.indicatorStyle === 'both')
			) {
				for (const c of markers) {
					const range = findAnchorRange(view.state.doc, c);
					if (range && pos >= range.from && pos <= range.to) {
						m = c;
						hoverRange = range;
						break;
					}
				}
			}
			if (!m || !hoverRange) return null;

			return {
				pos: hoverRange.from,
				end: hoverRange.to,
				above: true,
				// destroy is forwarded, not dropped: it unloads the popover's
				// markdown render lifetime. A hover tooltip is created and
				// destroyed on every dwell, so leaking one per hover would be the
				// fastest leak in the plugin.
				// The hover tooltip is rebuilt from scratch on every dwell, so
				// its comment cannot go stale and a constant ref is right.
				create: () => buildCommentPopover(ctx, view, { current: m }),
			};
		},
		{ hoverTime: HOVER_DELAY_MS[ctx.getSettings().hoverDelay] },
	);
}

// --------------------------------------------------------------------------
// Pinned tooltips (the reply composer and the tap popover)
// --------------------------------------------------------------------------
//
// Both fields hold the marker offset they are pinned to AND the Tooltip object
// itself. Storing the tooltip is what keeps the live DOM alive, and it fixes
// two separate bugs that used to make either surface vanish mid-use.
//
// The first was `showTooltip.compute([field, markersField], ...)`: markersField
// changes identity on every docChanged, so the tooltip object was rebuilt with
// a FRESH `create` closure on every document change. CodeMirror matches tooltip
// views by `create` identity, so a new closure means tear down the DOM and
// build a new one. Any edit anywhere in the note destroyed a composer the user
// was typing into, and the refill came from a 300ms-debounced draft that
// id-less comments never get: the typed reply was simply gone.
//
// The second was keeping a RAW offset and clearing the field unless a marker
// still started at exactly that number. Text inserted above the marker moves
// it, so an edit ABOVE closed the composer, dismissed the pinned popover, and
// dropped the active highlight, while an edit below did nothing. It read as
// random. Both now map the offset through the transaction's changes.
// A live handle on "the comment this surface is about". The builders below read
// through it instead of closing over a `Comment` value, and it is repointed on
// every remap.
//
// The indirection is what makes preserving the DOM safe. A preserved surface
// keeps the same `create` closure by design, so anything that closure captured
// is frozen at the moment the surface opened, including the comment's start and
// end offsets. `CommentService` resolves a comment WITHOUT an id by matching
// those offsets (an id-less marker has nothing else to match on), so after an
// edit above it, a frozen capture no longer matches anything: Send and every
// lifecycle action would report the comment as vanished, for as long as the
// surface stayed open. Closing the composer to escape that would take the typed
// reply with it, because id-less comments get no draft either.
interface CommentRef {
	current: Comment;
}

interface PinnedTooltip {
	// Where the marker starts and ends in the CURRENT document. `end` is kept
	// alongside `offset` so a change can be tested against the marker's whole
	// span without going back through the tooltip object for it.
	offset: number;
	end: number;
	// Shared with the tooltip's `create` closure, and repointed on every remap.
	ref: CommentRef;
	tooltip: Tooltip;
}

// Where a marker that started at `offset` starts after this transaction.
//
// `assoc: 1` is load-bearing. CodeMirror's mapPos defaults to -1, which keeps a
// position BEFORE text inserted exactly at it, but a marker is not a cursor: if
// you type at the end of the prose immediately preceding a marker, the inserted
// characters go in front of the `<!--`, so the marker now starts AFTER them.
// With the default association the lookup would miss by exactly the length of
// what was typed, read as "the marker is gone", and close the surface.
function mapMarkerStart(tr: Transaction, offset: number): number {
	return tr.changes.mapPos(offset, 1);
}

// Open (or refuse to open) a pinned tooltip at `offset`. `null` covers both the
// explicit close effect and a marker that is not there to pin to.
function openPinnedTooltip(
	state: EditorState,
	markersField: StateField<Comment[]>,
	offset: number | null,
	build: (ref: CommentRef) => Tooltip,
): PinnedTooltip | null {
	if (offset === null) return null;
	const m = state.field(markersField).find((c) => c.marker.start === offset);
	if (!m) return null;
	const ref: CommentRef = { current: m };
	return { offset, end: m.marker.end, ref, tooltip: build(ref) };
}

// Follow the marker through a document change. Returning null closes the
// surface, which is correct only when the marker is genuinely gone: deleted, or
// rewritten such that nothing starts where it used to.
//
// `rebuildWhenMarkerChanges` decides what happens when the change landed inside
// the marker's OWN span, which is what every lifecycle write does. The two
// surfaces want opposite things there, so neither default would be right for
// both:
//
//   - The popover renders the comment (replies, resolution, addressed note,
//     and which action buttons apply), and the usual way a comment changes is
//     the user pressing one of those buttons. It has to rebuild or it sits
//     there showing "Resolve" on an already-resolved comment.
//   - The composer holds text the user typed and has not sent. Nothing
//     happening to the comment justifies destroying that, so it never
//     rebuilds.
//
// Everything else (an edit anywhere else in the note, which is the case that
// used to destroy both surfaces on every keystroke) keeps the existing DOM.
function remapPinnedTooltip(
	value: PinnedTooltip,
	tr: Transaction,
	markersField: StateField<Comment[]>,
	build: (ref: CommentRef) => Tooltip,
	rebuildWhenMarkerChanges: boolean,
): PinnedTooltip | null {
	const mapped = mapMarkerStart(tr, value.offset);
	const m = tr.state
		.field(markersField)
		.find((c) => c.marker.start === mapped);
	if (!m) return null;
	// Point the ref at the comment as it stands NOW, before deciding whether to
	// rebuild. This is what keeps a preserved surface from acting on a stale
	// comment: see CommentRef.
	value.ref.current = m;
	if (
		rebuildWhenMarkerChanges &&
		tr.changes.touchesRange(value.offset, value.end)
	) {
		return {
			offset: mapped,
			end: m.marker.end,
			ref: value.ref,
			tooltip: build(value.ref),
		};
	}
	// Spreading the existing tooltip is load-bearing, not a style choice: it
	// carries the SAME `create` reference across, and CodeMirror matches
	// tooltip views by `create` identity, so this is the only reason it
	// repositions the existing DOM instead of tearing it down and building a
	// new one. Do not construct a fresh tooltip object here.
	return {
		offset: mapped,
		end: m.marker.end,
		// The same ref, already repointed above, so the preserved DOM's
		// callbacks act on the comment as it stands rather than on the copy
		// they closed over when the surface opened.
		ref: value.ref,
		tooltip: { ...value.tooltip, pos: mapped, end: m.marker.end },
	};
}

// Pinned reply composer: opened by the popup's Reply button. Uses showTooltip
// so it persists across mouse moves; dismissed only by Send or Cancel.
function replyComposerField(
	ctx: DecorationContext,
	markersField: StateField<Comment[]>,
): StateField<PinnedTooltip | null> {
	const build = (ref: CommentRef): Tooltip => ({
		pos: ref.current.marker.start,
		end: ref.current.marker.end,
		above: true,
		strictSide: false,
		create: (view) => buildReplyComposerDom(view, ctx, ref),
	});
	return StateField.define<PinnedTooltip | null>({
		create: () => null,
		update(value, tr) {
			for (const e of tr.effects) {
				if (e.is(setReplyComposerEffect)) {
					return openPinnedTooltip(
						tr.state,
						markersField,
						e.value,
						build,
					);
				}
			}
			if (tr.docChanged && value !== null) {
				// false: never rebuild. The textarea holds unsent text.
				return remapPinnedTooltip(
					value,
					tr,
					markersField,
					build,
					false,
				);
			}
			return value;
		},
		provide: (f) => showTooltip.from(f, (v) => v?.tooltip ?? null),
	});
}

function buildReplyComposerDom(
	view: EditorView,
	ctx: DecorationContext,
	ref: CommentRef,
): { dom: HTMLElement } {
	// The comment as it stood when the composer opened, for everything drawn
	// once. Anything that runs LATER (Send, draft saves) must read `ref.current`
	// instead, because this DOM is deliberately preserved across document
	// changes and `m` goes stale the moment the marker moves.
	const m = ref.current;
	const dom = view.dom.ownerDocument.win.createDiv();
	dom.addClass('annoteca-reply-composer');
	queueMicrotask(() => {
		const tip = dom.closest('.cm-tooltip');
		if (isElementAcrossRealms(tip))
			tip.addClass('annoteca-reply-composer-tooltip');
	});

	const head = dom.createDiv({ cls: 'annoteca-reply-composer-head' });
	head.createSpan({
		cls: 'annoteca-reply-composer-title',
		text: `Reply to ${m.category}`,
	});

	// F-274: per-reply author picker. Options are the configured author tags plus
	// any authors already in this thread, so distinct collaborators can each sign
	// their own reply. Defaults to the configured author tag.
	const defaultAuthor = ctx.getAuthorTag();
	const threadAuthors = [m.author, ...m.replies.map((r) => r.author)].filter(
		(a): a is string => typeof a === 'string' && a.trim() !== '',
	);
	const optionTags: string[] = [];
	const seenTags = new Set<string>();
	for (const tag of [
		defaultAuthor,
		...ctx.getAuthorOptions(),
		...threadAuthors,
	]) {
		const t = tag.trim();
		if (t === '' || seenTags.has(t)) continue;
		seenTags.add(t);
		optionTags.push(t);
	}
	const authorLabel = head.createSpan({
		cls: 'annoteca-reply-composer-author',
		text: 'as',
	});
	const authorSelect = authorLabel.createEl('select', {
		cls: 'annoteca-reply-composer-author-select dropdown',
	});
	for (const tag of optionTags)
		authorSelect.createEl('option', { value: tag, text: tag });
	authorSelect.value = defaultAuthor;

	const textarea = dom.createEl('textarea', {
		cls: 'annoteca-reply-composer-textarea',
	});
	textarea.rows = 3;
	textarea.placeholder = 'Write a reply…';

	// Restore any draft saved for this comment. Comments without an id cannot
	// have drafts saved against them (no stable key), so we skip that case.
	const draftKey = m.id;
	if (draftKey) {
		const saved = ctx.loadDraft(draftKey);
		if (saved.length > 0) textarea.value = saved;
	}

	// Defer focus until after the tooltip is positioned by CM6, then move the
	// cursor to the end so a restored draft is continuation-friendly.
	window.setTimeout(() => {
		textarea.focus();
		textarea.setSelectionRange(
			textarea.value.length,
			textarea.value.length,
		);
	}, 0);

	// Debounce draft saves so we don't write on every keystroke. 300ms is the
	// sweet spot between "feels live" and "doesn't thrash localStorage".
	let saveTimer: number | undefined;
	const scheduleSave = (): void => {
		if (!draftKey) return;
		if (saveTimer !== undefined) window.clearTimeout(saveTimer);
		saveTimer = window.setTimeout(() => {
			ctx.saveDraft(draftKey, textarea.value);
			saveTimer = undefined;
		}, 300);
	};
	textarea.addEventListener('input', scheduleSave);

	const buttons = dom.createDiv({ cls: 'annoteca-reply-composer-buttons' });

	const cancel = buttons.createEl('button', {
		cls: 'annoteca-hover-action',
		text: 'Cancel',
	});
	cancel.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		// Cancel preserves the draft (Gmail behavior). The composer just hides;
		// next open will restore the text.
		view.dispatch({ effects: setReplyComposerEffect.of(null) });
	});

	const send = buttons.createEl('button', {
		cls: 'annoteca-hover-action mod-cta',
		text: 'Send',
	});
	// Submitting is asynchronous now that the write can be refused, which opens a
	// window the synchronous version did not have. Three things have to hold
	// across it, and none of them are handled by disabling the button alone:
	// Send is not the only way in (Cmd/Ctrl+Enter calls this directly), text
	// typed mid-flight would be thrown away by a callback that then closes the
	// composer, and the debounced draft save could fire after the draft was
	// cleared and resurrect it.
	let pending = false;
	const submit = (): void => {
		if (pending) return;
		const body = textarea.value.trim();
		if (body.length === 0) return;
		pending = true;
		send.disabled = true;
		// Read-only rather than merely ignored, so the user is not typing into a
		// field whose contents are about to be discarded.
		textarea.readOnly = true;
		// Flush the debounced draft save rather than cancelling it. Cancelling
		// alone fixed the resurrection problem (a queued save landing after
		// clearDraft and bringing the sent text back) but created a worse one:
		// submitting within the 300ms debounce meant the newest text had never
		// been stored, so a refused or failed write left it only in a textarea
		// that closing the composer discards. Saving now, clearing only on
		// success, is correct in both directions.
		if (saveTimer !== undefined) {
			window.clearTimeout(saveTimer);
			saveTimer = undefined;
		}
		if (draftKey) ctx.saveDraft(draftKey, textarea.value);
		// The write is awaited, and the composer can be dismissed across that
		// await: Escape, Cancel, or anything that tears the tooltip down. Then
		// release() re-enables a Send button and a textarea that are no longer
		// in the document, and the catch branch raises a Notice about a
		// composer the user has already closed. Checking the textarea rather
		// than a flag catches every teardown path, including the ones that do
		// not run through this closure at all.
		const release = (): boolean => {
			if (!textarea.isConnected) return false;
			pending = false;
			send.disabled = false;
			textarea.readOnly = false;
			return true;
		};
		void ctx
			// ref.current, not the captured `m`: this composer survives edits
			// to the note, and an id-less comment is resolved by its offsets,
			// so sending against the open-time copy would be refused as
			// "vanished" after any edit above the marker.
			.submitReply(
				ref.current,
				body,
				authorSelect.value,
				sourcePathFor(ctx, view),
			)
			.then((wrote) => {
				if (!wrote) {
					// Leave the composer open with the text still in it. The
					// refusal has already explained itself, and the user can
					// retry once the note catches up.
					release();
					return;
				}
				if (draftKey) ctx.clearDraft(draftKey);
				view.dispatch({ effects: setReplyComposerEffect.of(null) });
			})
			.catch(() => {
				// A vault read or write can reject on an adapter, permission, or
				// transient I/O error. Without this the composer stays disabled
				// with the user's text trapped in it, and the rejection surfaces
				// as an unhandled promise. The text is kept and Send works again.
				// A dismissed composer stays dismissed and says nothing.
				if (release())
					new Notice('Could not save the reply. Try again.');
			});
	};
	send.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		submit();
	});

	textarea.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			view.dispatch({ effects: setReplyComposerEffect.of(null) });
		} else if (
			shouldSubmitOnKeydown(e, ctx.getSettings().submitCommentOnEnter)
		) {
			e.preventDefault();
			submit();
		}
	});

	// Stop propagation on mousedown so clicking inside the composer does not
	// dismiss it via the outside-click handler registered below.
	dom.addEventListener('mousedown', (e) => e.stopPropagation());

	return { dom };
}

function dismissReplyOnOutsideClick(): Extension {
	return EditorView.domEventHandlers({
		mousedown: (event, view) => {
			const target = event.target as HTMLElement | null;
			if (!target) return false;
			if (target.closest('.annoteca-reply-composer')) return false;
			const field = replyComposerStateRef.field;
			if (!field) return false;
			const open = view.state.field(field, false);
			if (open == null) return false;
			// Preserve in-progress text. If the user has typed anything into
			// the composer, treat outside-click as a no-op so a misclick does
			// not throw away their work. Cancel and Escape still dismiss.
			// Drafts are persisted on input, so even if the composer dies the
			// text is recoverable, but keeping it visible avoids the surprise.
			const textarea = view.dom.querySelector<HTMLTextAreaElement>(
				'.annoteca-reply-composer-textarea',
			);
			if (textarea && textarea.value.length > 0) return false;
			view.dispatch({ effects: setReplyComposerEffect.of(null) });
			return false;
		},
	});
}

// Tiny ref so dismissReplyOnOutsideClick can read the state field without a
// circular import between the field constructor and the handler. Assigned
// inside buildAnnotecaExtension once replyField has been constructed.
const replyComposerStateRef: { field?: StateField<PinnedTooltip | null> } = {};

// --------------------------------------------------------------------------
// Tap-anchored popover: the click/tap counterpart to the hover preview.
// --------------------------------------------------------------------------

// Decides what activating a marker does. Both entry points route through here,
// the inline icon widget (which handles its own click because it returns true
// from ignoreEvent) and the click handler that covers the anchor underline, so
// the two can never disagree about what a click means.
function activateMarker(
	ctx: DecorationContext,
	view: EditorView,
	m: Comment,
): void {
	if (ctx.getSettings().markerClickAction === 'popover') {
		view.dispatch({
			effects: setTapPopoverEffect.of(m.marker.start),
		});
		return;
	}
	ctx.onMarkerClick(m);
}

function tapPopoverField(
	ctx: DecorationContext,
	markersField: StateField<Comment[]>,
): StateField<PinnedTooltip | null> {
	const build = (ref: CommentRef): Tooltip => ({
		pos: ref.current.marker.start,
		end: ref.current.marker.end,
		above: true,
		strictSide: false,
		// The same builder the hover tooltip uses, so the two surfaces cannot
		// drift apart. Returned whole, so its destroy hook reaches CodeMirror
		// too.
		create: (view) => buildCommentPopover(ctx, view, ref),
	});
	return StateField.define<PinnedTooltip | null>({
		create: () => null,
		update(value, tr) {
			for (const e of tr.effects) {
				if (e.is(setTapPopoverEffect)) {
					return openPinnedTooltip(
						tr.state,
						markersField,
						e.value,
						build,
					);
				}
				// Opening the reply composer supersedes the popover. The
				// composer is launched FROM the popover's Reply button, and
				// leaving both pinned stacks two tooltips on the same marker.
				if (e.is(setReplyComposerEffect) && e.value !== null)
					return null;
			}
			// Follow the marker, and drop the popover only when it is really
			// gone. Without the drop, deleting from inside the popover leaves
			// it pinned to a range that no longer exists.
			if (tr.docChanged && value !== null) {
				// true: a lifecycle write changes what this surface is drawing,
				// and pressing its own buttons is the usual way that happens.
				return remapPinnedTooltip(value, tr, markersField, build, true);
			}
			return value;
		},
		provide: (f) => showTooltip.from(f, (v) => v?.tooltip ?? null),
	});
}

const tapPopoverStateRef: { field?: StateField<PinnedTooltip | null> } = {};

// Whether a click at `target` should leave THIS view's pinned popover alone.
function clickKeepsTapPopover(view: EditorView, target: HTMLElement): boolean {
	// The popover and the reply composer render into their window's body rather
	// than into any editor (see `perWindowTooltipHost`), so containment cannot
	// scope them; they are exempt wherever they sit.
	if (target.closest('.annoteca-hover-preview')) return true;
	if (target.closest('.annoteca-reply-composer')) return true;
	// A marker click is handled by activateMarker, which re-points this view's
	// popover, so dismissing first would only make it flicker. But the
	// exemption has to be scoped to THIS view: with a split, a marker in
	// another pane is an outside click here, and treating it as exempt would
	// let every pane accumulate its own pinned popover.
	const marker = target.closest(
		'.annoteca-marker, .annoteca-icon, .annoteca-anchor',
	);
	if (marker && view.dom.contains(marker)) return true;
	return false;
}

// Dismissal is registered on the DOCUMENT, not through
// EditorView.domEventHandlers. An editor-scoped handler only sees events that
// originate inside that editor, so clicking the sidebar, the ribbon, or another
// pane would leave the popover pinned indefinitely while looking like an
// outside click to the user. The tooltip is also rendered into the body of the
// editor's own window (see `perWindowTooltipHost`), so it is genuinely outside
// the editor's DOM. The listener goes on `view.dom.ownerDocument`, which is
// that same window, so a popout's clicks reach a popout's popover.
//
// Capture phase, so a handler that stops propagation cannot strand the popover.
// The listener is torn down in destroy(); a per-editor global listener that
// outlived its view would fire against a detached state.
function dismissTapPopoverOnOutsideClick(): Extension {
	return ViewPlugin.fromClass(
		class {
			private readonly doc: Document;
			private readonly onDown: (event: MouseEvent) => void;

			constructor(view: EditorView) {
				this.doc = view.dom.ownerDocument;
				this.onDown = (event: MouseEvent) => {
					const target = event.target as HTMLElement | null;
					if (!target) return;
					if (clickKeepsTapPopover(view, target)) return;
					const field = tapPopoverStateRef.field;
					if (!field) return;
					// `false` guards against the field being absent from this
					// view's state, which happens while extensions reconfigure.
					if (view.state.field(field, false) == null) return;
					view.dispatch({ effects: setTapPopoverEffect.of(null) });
				};
				this.doc.addEventListener('mousedown', this.onDown, true);
			}

			destroy(): void {
				this.doc.removeEventListener('mousedown', this.onDown, true);
			}
		},
	);
}

// --------------------------------------------------------------------------
// Active-comment highlight (F-276): a background mark over the comment whose
// thread is open in the side panel, so selecting a comment keeps it visually
// anchored in the editor.
// --------------------------------------------------------------------------

function activeCommentField(
	markersField: StateField<Comment[]>,
): StateField<number | null> {
	return StateField.define<number | null>({
		create: () => null,
		update(value, tr) {
			for (const e of tr.effects) {
				if (e.is(setActiveCommentEffect)) return e.value;
			}
			// Follow the marker through the edit, then drop the highlight only
			// if it is genuinely gone (deleted, or its own span rewritten).
			// Without the mapping an edit ABOVE the comment moved the marker
			// and cleared the highlight, while an edit below left it alone.
			if (tr.docChanged && value !== null) {
				const mapped = mapMarkerStart(tr, value);
				const markers = tr.state.field(markersField);
				if (!markers.some((m) => m.marker.start === mapped))
					return null;
				return mapped;
			}
			return value;
		},
	});
}

function activeCommentDecorations(
	markersField: StateField<Comment[]>,
	activeField: StateField<number | null>,
): Extension {
	return EditorView.decorations.compute(
		[markersField, activeField, hideAllField],
		(state) => {
			const start = state.field(activeField);
			const markers = state.field(markersField);
			const m =
				start === null
					? undefined
					: markers.find((c) => c.marker.start === start);
			const anchorRange = m ? findAnchorRange(state.doc, m) : null;
			const specs = planActiveCommentDecorations(
				start,
				markers,
				anchorRange,
				state.field(hideAllField),
			);
			if (specs.length === 0) return Decoration.none;
			return Decoration.set(
				specs.map((s) =>
					Decoration.mark({ class: s.cls }).range(s.from, s.to),
				),
				true,
			);
		},
	);
}

function clickHandlerExtension(
	ctx: DecorationContext,
	field: StateField<Comment[]>,
): Extension {
	return EditorView.domEventHandlers({
		click: (event, view) => {
			if (view.state.field(hideAllField)) return false;
			const target = event.target as HTMLElement | null;
			if (!target) return false;
			if (event.button !== 0) return false;

			const markerEl = target.closest(
				'.annoteca-marker, .annoteca-icon, .annoteca-anchor',
			);
			if (!markerEl) return false;

			// The icon/marker spans carry `data-annoteca-marker-start`. The
			// anchor underline spans carry `data-annoteca-anchor-for`, which
			// also stores the marker's start offset. Either resolves the same
			// way.
			const startAttr =
				markerEl.getAttribute('data-annoteca-marker-start') ??
				markerEl.getAttribute('data-annoteca-anchor-for');
			if (!startAttr) return false;
			const start = Number.parseInt(startAttr, 10);
			if (Number.isNaN(start)) return false;

			const markers = view.state.field(field);
			const m = markers.find((c) => c.marker.start === start);
			if (!m) return false;
			activateMarker(ctx, view, m);
			event.preventDefault();
			event.stopPropagation();
			return true;
		},
	});
}

// Selection popup: a small floating "Comment" button anchored at the end of a
// non-empty selection. Opt-in via settings.selectionPopup. Derived purely from
// selection state (no effect/field), so it appears and follows the selection as
// the user drags, and disappears when the selection collapses. Gives a one-
// click path to the composer without the right-click menu.
function selectionPopupExtension(ctx: DecorationContext): Extension {
	// settingsEpochField is a dependency because the body below reads
	// `selectionPopup` off the live settings object. A facet only recomputes
	// when a declared dependency changes, and mutating the settings object
	// changes nothing CodeMirror tracks, so with 'selection' alone toggling the
	// setting did nothing until the user happened to move the selection.
	return showTooltip.compute(['selection', settingsEpochField], (state) => {
		if (!ctx.getSettings().selectionPopup) return null;
		const sel = state.selection.main;
		if (sel.empty) return null;
		return {
			pos: sel.to,
			above: true,
			strictSide: false,
			create: () => buildSelectionPopupDom(ctx),
		};
	});
}

function buildSelectionPopupDom(ctx: DecorationContext): { dom: HTMLElement } {
	const dom = activeWindow.createDiv();
	dom.addClass('annoteca-selection-popup');
	queueMicrotask(() => {
		// The .cm-tooltip frame is an ancestor, not necessarily our direct
		// parent, so closest() targets it reliably; parentElement missed it and
		// left the default white tooltip box showing.
		const tip = dom.closest('.cm-tooltip');
		if (isElementAcrossRealms(tip))
			tip.addClass('annoteca-selection-popup-tooltip');
	});

	const btn = dom.createEl('button', {
		// mod-cta is Obsidian's own accent-button class (same as the Send
		// button); using it gets the accent fill natively instead of fighting
		// the tooltip button cascade for background-color.
		cls: 'annoteca-selection-popup-button mod-cta',
		attr: { type: 'button', 'aria-label': 'Add comment for selection' },
	});
	const icon = btn.createSpan({ cls: 'annoteca-selection-popup-icon' });
	setIcon(icon, 'message-square-plus');
	btn.createSpan({ cls: 'annoteca-selection-popup-label', text: 'Comment' });

	// preventDefault on mousedown keeps the editor selection intact: without it,
	// pressing the button moves focus and collapses the selection before the
	// composer can read it.
	btn.addEventListener('mousedown', (e) => e.preventDefault());
	btn.addEventListener('click', () => ctx.addCommentForSelection());

	return { dom };
}

// The document-driven half of the extension: parsed markers, hide-all
// visibility, and the decorations computed from them. Deliberately free of
// tooltip and pointer wiring, because that half needs Obsidian's
// `activeWindow` and a live DOM. Keeping the split lets the decoration
// behaviour be exercised headlessly (see `__tests__/decorations.test.ts`),
// which is the only way to catch a visibility change that fails to repaint.
// Returns the fields as well, since the DOM half attaches to the same
// instances.
export function buildMarkerDecorations(ctx: DecorationContext): {
	extension: Extension;
	markerField: StateField<Comment[]>;
	activeField: StateField<number | null>;
} {
	const field = markerStateField(ctx);
	const activeField = activeCommentField(field);
	return {
		extension: [
			field,
			hideAllField,
			showBodiesField,
			settingsEpochField,
			activeField,
			activeCommentDecorations(field, activeField),
			decorationsCompute(ctx, field),
		],
		markerField: field,
		activeField,
	};
}

export function buildAnnotecaExtension(ctx: DecorationContext): Extension {
	const { extension: markerDecorations, markerField: field } =
		buildMarkerDecorations(ctx);
	const replyField = replyComposerField(ctx, field);
	replyComposerStateRef.field = replyField;
	const tapField = tapPopoverField(ctx, field);
	tapPopoverStateRef.field = tapField;
	return [
		markerDecorations,
		trackLiveView,
		replyField,
		tapField,
		tooltipParentCompartment.of([]),
		perWindowTooltipHost(),
		selectionPopupExtension(ctx),
		hoverTooltipExtension(ctx, field),
		clickHandlerExtension(ctx, field),
		dismissReplyOnOutsideClick(),
		dismissTapPopoverOnOutsideClick(),
	];
}

// Helper used by main.ts when registering navigation commands. Pure over the
// editor document.
export function findMarkersInDoc(content: string): Comment[] {
	return parseAll(content);
}
