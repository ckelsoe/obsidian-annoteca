// CodeMirror 6 extension that decorates Annoteca markers in the editor and
// wires hover/click interactions back to the plugin. Implements F-031, F-032,
// F-033, F-034, F-037, F-038 from features.md.

import {
	StateField,
	StateEffect,
	type Extension,
	type Range,
	type Transaction,
} from "@codemirror/state";
import {
	Decoration,
	EditorView,
	WidgetType,
	hoverTooltip,
	showTooltip,
	tooltips,
	type Tooltip,
} from "@codemirror/view";

import type { Comment } from "./types";
import type { AnnotecaSettings } from "./types";
import { parseAll } from "./parser";

export interface DecorationContext {
	getSettings(): AnnotecaSettings;
	onMarkerClick(marker: Comment): void;
	openInReviewer(marker: Comment): void;
	toggleResolution(marker: Comment): void;
	copyPermalink(marker: Comment): void;
	submitReply(marker: Comment, body: string): void;
	getAuthorTag(): string;
	isStarred(marker: Comment): boolean;
	toggleStarred(marker: Comment): void;
	loadDraft(commentId: string): string;
	saveDraft(commentId: string, body: string): void;
	clearDraft(commentId: string): void;
}

// Module-level transient state. Editor open/close re-evaluates these. Toggling
// hide-all is a single global flag the StateField reads on every update.
const hideAllFlag = { value: false };

export const setHideAllCommentsEffect = StateEffect.define<boolean>();

// Reply composer state. The pinned tooltip below uses this to render a textarea
// at a specific marker. `null` means no composer is open.
const setReplyComposerEffect = StateEffect.define<number | null>();

export function setHideAllComments(view: EditorView, hide: boolean): void {
	hideAllFlag.value = hide;
	view.dispatch({ effects: setHideAllCommentsEffect.of(hide) });
}

export function isHideAllComments(): boolean {
	return hideAllFlag.value;
}

const markerStateField = (_ctx: DecorationContext) => StateField.define<Comment[]>({
	create(state) {
		return parseAll(state.doc.toString());
	},
	update(value, tr: Transaction) {
		if (!tr.docChanged && !tr.effects.some(e => e.is(setHideAllCommentsEffect))) {
			return value;
		}
		if (tr.docChanged) {
			return parseAll(tr.state.doc.toString());
		}
		return value;
	},
});

class MarkerIconWidget extends WidgetType {
	constructor(private readonly marker: Comment) {
		super();
	}

	override eq(other: WidgetType): boolean {
		if (!(other instanceof MarkerIconWidget)) return false;
		const o = other.marker;
		const m = this.marker;
		return o.marker.start === m.marker.start
			&& o.marker.end === m.marker.end
			&& o.category === m.category
			&& o.body === m.body
			&& o.resolution === m.resolution;
	}

	override toDOM(view: EditorView): HTMLElement {
		const el = view.dom.ownerDocument.createElement("span");
		el.className = `annoteca-icon annoteca-cat-${this.marker.category}`;
		el.setAttribute("data-annoteca-marker-start", String(this.marker.marker.start));
		el.setAttribute("data-annoteca-marker-end", String(this.marker.marker.end));
		if (this.marker.resolution) el.classList.add("annoteca-resolved");
		if (this.marker.replies.length > 0) el.classList.add("annoteca-has-replies");
		el.title = `${this.marker.category}: ${this.marker.body.slice(0, 80)}`;
		// Single character for all marker states. Resolved status is conveyed
		// via the annoteca-resolved CSS class (opacity + strikethrough), not
		// a different character — switching shapes (◆ vs ●) at small font
		// sizes reads as visual noise rather than meaningful state.
		el.textContent = "◆";
		return el;
	}

	override ignoreEvent(event: Event): boolean {
		// Prevent CM6 from treating clicks on the icon as cursor placement.
		// Without this, clicking the icon moves the cursor into the marker
		// range, which triggers the raw-text "edit" rendering branch below.
		// The plugin's domEventHandlers click handler still fires and routes
		// to openReviewerOnComment via onMarkerClick.
		if (event.type === "mousedown" || event.type === "click") return true;
		return false;
	}
}

function classListForMarker(c: Comment, ctxSettings: AnnotecaSettings): string {
	const classes = ["annoteca-marker", `annoteca-cat-${c.category}`];
	if (c.resolution) {
		if (ctxSettings.resolvedDisplay === "hide") classes.push("annoteca-resolved-hidden");
		else classes.push("annoteca-resolved");
	}
	return classes.join(" ");
}

function selectionTouches(state: { selection: { ranges: ReadonlyArray<{ from: number; to: number }> } }, m: Comment): boolean {
	for (const r of state.selection.ranges) {
		if (r.from === r.to) {
			// Bare cursor (no selection). Only count it as "inside" the marker
			// when the cursor sits strictly between the marker boundaries.
			// A cursor exactly at marker.start or marker.end is visually
			// adjacent, not inside, and should keep the icon widget shown.
			// This covers programmatic cursor placement (Open button, next /
			// previous commands) landing the cursor at the marker's start.
			if (r.from > m.marker.start && r.from < m.marker.end) return true;
		} else {
			// Range selection that overlaps the marker — user is actively
			// selecting through it (e.g., to copy or replace).
			if (r.from < m.marker.end && r.to > m.marker.start) return true;
		}
	}
	return false;
}

function decorationsCompute(ctx: DecorationContext, field: StateField<Comment[]>): Extension {
	return EditorView.decorations.compute([field, "selection"], state => {
		if (hideAllFlag.value) return Decoration.none;
		const markers = state.field(field);
		const settings = ctx.getSettings();
		// "gutter" mode: gutter shows the markers; suppress inline decorations.
		if (settings.indicatorStyle === "none" || settings.indicatorStyle === "gutter") {
			return Decoration.none;
		}

		// Build a list sorted by start, since RangeSetBuilder requires monotone
		// order. parseAll returns markers in document order already, but sort
		// defensively in case the parser ever changes.
		const sorted = [...markers].sort((a, b) => a.marker.start - b.marker.start);
		const decorations: Range<Decoration>[] = [];
		for (const m of sorted) {
			const touched = selectionTouches(state, m);
			if (touched) {
				// Cursor is inside the marker — show the raw text so the user
				// can edit it directly. Style it so it stays readable.
				decorations.push(
					Decoration.mark({
						class: classListForMarker(m, settings),
						attributes: {
							"data-annoteca-marker-start": String(m.marker.start),
							"data-annoteca-marker-end": String(m.marker.end),
						},
					}).range(m.marker.start, m.marker.end),
				);
			} else {
				// Cursor is outside — replace the raw text with a single icon
				// widget. This is the live-preview behavior the spec asks for:
				// "invisible in rendered markdown and decorated in editing
				// modes as small icons".
				decorations.push(
					Decoration.replace({
						widget: new MarkerIconWidget(m),
						inclusive: false,
					}).range(m.marker.start, m.marker.end),
				);
			}
		}
		return Decoration.set(decorations, true);
	});
}

// --------------------------------------------------------------------------
// Hover popup: full conversation + action buttons.
// --------------------------------------------------------------------------

const MAX_REPLIES_IN_POPUP = 3;

function renderReplyRow(reply: { author: string; date: string; body: string }, parent: HTMLElement): void {
	const row = parent.createDiv({ cls: "annoteca-hover-reply" });
	const head = row.createDiv({ cls: "annoteca-hover-reply-head" });
	head.createSpan({ cls: "annoteca-hover-reply-author", text: reply.author });
	head.createSpan({ cls: "annoteca-hover-reply-date", text: reply.date });
	row.createDiv({ cls: "annoteca-hover-reply-body", text: reply.body });
}

function hoverTooltipExtension(ctx: DecorationContext, field: StateField<Comment[]>): Extension {
	return hoverTooltip((view, pos): Tooltip | null => {
		if (hideAllFlag.value) return null;
		const settings = ctx.getSettings();
		if (settings.indicatorStyle === "none") return null;
		const markers = view.state.field(field);
		const m = markers.find(c => pos >= c.marker.start && pos <= c.marker.end);
		if (!m) return null;

		return {
			pos: m.marker.start,
			end: m.marker.end,
			above: true,
			create: () => {
				const dom = view.dom.ownerDocument.createElement("div");
				dom.addClass("annoteca-hover-preview");
				// Tag the outer .cm-tooltip wrapper so styles.css can scope to it.
				queueMicrotask(() => {
					const wrapper = dom.parentElement;
					if (wrapper) wrapper.addClass("annoteca-hover-tooltip");
				});

				const header = dom.createDiv({ cls: "annoteca-hover-header" });
				header.createSpan({
					cls: `annoteca-hover-category annoteca-cat-${m.category}`,
					text: m.category,
				});
				if (m.resolution) {
					header.createSpan({ cls: "annoteca-hover-state", text: "resolved" });
				}
				if (m.date) {
					header.createSpan({ cls: "annoteca-hover-date", text: m.date });
				}
				if (m.author) {
					header.createSpan({ cls: "annoteca-hover-author", text: m.author });
				}

				// Star toggle pinned to the far right via margin-left: auto in CSS.
				// Disabled visually + interactively for comments without an id.
				const starBtn = header.createEl("button", {
					cls: "annoteca-hover-star",
					text: "★",
				});
				const hasId = Boolean(m.id);
				const starred = hasId && ctx.isStarred(m);
				if (starred) starBtn.addClass("is-starred");
				if (!hasId) starBtn.addClass("is-disabled");
				starBtn.setAttribute(
					"aria-label",
					hasId ? (starred ? "Unstar comment" : "Star comment") : "Comment has no ID",
				);
				starBtn.addEventListener("click", e => {
					e.preventDefault();
					e.stopPropagation();
					if (!hasId) return;
					ctx.toggleStarred(m);
					starBtn.toggleClass("is-starred", !starred);
					starBtn.setAttribute(
						"aria-label",
						!starred ? "Unstar comment" : "Star comment",
					);
				});

				dom.createDiv({ cls: "annoteca-hover-body", text: m.body });

				const repliesCount = m.replies.length;
				if (repliesCount > 0) {
					const repliesBlock = dom.createDiv({ cls: "annoteca-hover-replies-list" });
					const shown = m.replies.slice(-MAX_REPLIES_IN_POPUP);
					const earlier = repliesCount - shown.length;
					if (earlier > 0) {
						const more = repliesBlock.createEl("button", {
							cls: "annoteca-hover-more-link",
							text: `+${earlier} earlier ${earlier === 1 ? "reply" : "replies"} — open in side panel`,
						});
						more.addEventListener("click", e => {
							e.preventDefault();
							e.stopPropagation();
							ctx.openInReviewer(m);
						});
					}
					for (const r of shown) renderReplyRow(r, repliesBlock);
				}

				if (m.resolution && m.resolution.note) {
					const block = dom.createDiv({ cls: "annoteca-hover-resolution" });
					const head = block.createDiv({ cls: "annoteca-hover-resolution-head" });
					head.createSpan({ cls: "annoteca-hover-reply-author", text: m.resolution.author });
					head.createSpan({ cls: "annoteca-hover-reply-date", text: m.resolution.date });
					block.createDiv({ cls: "annoteca-hover-reply-body", text: m.resolution.note });
				}

				const actions = dom.createDiv({ cls: "annoteca-hover-actions" });

				const openBtn = actions.createEl("button", {
					cls: "annoteca-hover-action",
					text: "Open in side panel",
				});
				openBtn.addEventListener("click", e => {
					e.preventDefault();
					e.stopPropagation();
					ctx.openInReviewer(m);
				});

				const replyBtn = actions.createEl("button", {
					cls: "annoteca-hover-action",
					text: "Reply",
				});
				replyBtn.addEventListener("click", e => {
					e.preventDefault();
					e.stopPropagation();
					view.dispatch({ effects: setReplyComposerEffect.of(m.marker.start) });
				});

				const resolveBtn = actions.createEl("button", {
					cls: "annoteca-hover-action",
					text: m.resolution ? "Reopen" : "Resolve",
				});
				resolveBtn.addEventListener("click", e => {
					e.preventDefault();
					e.stopPropagation();
					ctx.toggleResolution(m);
				});

				if (m.id) {
					const copyBtn = actions.createEl("button", {
						cls: "annoteca-hover-action",
						text: "Copy ID",
					});
					copyBtn.addEventListener("click", e => {
						e.preventDefault();
						e.stopPropagation();
						ctx.copyPermalink(m);
					});
				}

				return { dom };
			},
		};
	});
}

// --------------------------------------------------------------------------
// Pinned reply composer: opened by the popup's Reply button. Uses showTooltip
// so it persists across mouse moves; dismissed only by Send or Cancel.
// --------------------------------------------------------------------------

function replyComposerField(ctx: DecorationContext, markersField: StateField<Comment[]>): StateField<number | null> {
	return StateField.define<number | null>({
		create: () => null,
		update(value, tr) {
			for (const e of tr.effects) {
				if (e.is(setReplyComposerEffect)) return e.value;
			}
			// Clear the composer if the underlying marker no longer exists
			// (deleted, rewritten by another action, etc).
			if (tr.docChanged && value !== null) {
				const markers = tr.state.field(markersField);
				if (!markers.some(m => m.marker.start === value)) return null;
			}
			return value;
		},
		provide: f => showTooltip.compute([f, markersField], state => {
			const markerStart = state.field(f);
			if (markerStart === null) return null;
			const markers = state.field(markersField);
			const m = markers.find(c => c.marker.start === markerStart);
			if (!m) return null;
			return {
				pos: m.marker.start,
				end: m.marker.end,
				above: true,
				strictSide: false,
				create: view => buildReplyComposerDom(view, ctx, m),
			};
		}),
	});
}

function buildReplyComposerDom(view: EditorView, ctx: DecorationContext, m: Comment): { dom: HTMLElement } {
	const dom = view.dom.ownerDocument.createElement("div");
	dom.addClass("annoteca-reply-composer");
	queueMicrotask(() => {
		const wrapper = dom.parentElement;
		if (wrapper) wrapper.addClass("annoteca-reply-composer-tooltip");
	});

	const head = dom.createDiv({ cls: "annoteca-reply-composer-head" });
	head.createSpan({
		cls: "annoteca-reply-composer-title",
		text: `Reply to ${m.category}`,
	});
	const authorTag = ctx.getAuthorTag();
	head.createSpan({
		cls: "annoteca-reply-composer-author",
		text: `as ${authorTag}`,
	});

	const textarea = dom.createEl("textarea", { cls: "annoteca-reply-composer-textarea" });
	textarea.rows = 3;
	textarea.placeholder = "Write a reply…";

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
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
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
	textarea.addEventListener("input", scheduleSave);

	const buttons = dom.createDiv({ cls: "annoteca-reply-composer-buttons" });

	const cancel = buttons.createEl("button", {
		cls: "annoteca-hover-action",
		text: "Cancel",
	});
	cancel.addEventListener("click", e => {
		e.preventDefault();
		e.stopPropagation();
		// Cancel preserves the draft (Gmail behavior). The composer just hides;
		// next open will restore the text.
		view.dispatch({ effects: setReplyComposerEffect.of(null) });
	});

	const send = buttons.createEl("button", {
		cls: "annoteca-hover-action mod-cta",
		text: "Send",
	});
	const submit = (): void => {
		const body = textarea.value.trim();
		if (body.length === 0) return;
		ctx.submitReply(m, body);
		if (draftKey) ctx.clearDraft(draftKey);
		view.dispatch({ effects: setReplyComposerEffect.of(null) });
	};
	send.addEventListener("click", e => {
		e.preventDefault();
		e.stopPropagation();
		submit();
	});

	textarea.addEventListener("keydown", e => {
		if (e.key === "Escape") {
			e.preventDefault();
			view.dispatch({ effects: setReplyComposerEffect.of(null) });
		} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			submit();
		}
	});

	// Stop propagation on mousedown so clicking inside the composer does not
	// dismiss it via the outside-click handler registered below.
	dom.addEventListener("mousedown", e => e.stopPropagation());

	return { dom };
}

function dismissReplyOnOutsideClick(): Extension {
	return EditorView.domEventHandlers({
		mousedown: (event, view) => {
			const target = event.target as HTMLElement | null;
			if (!target) return false;
			if (target.closest(".annoteca-reply-composer")) return false;
			const open = view.state.field(replyComposerStateRef.field, false);
			if (open == null) return false;
			// Preserve in-progress text. If the user has typed anything into
			// the composer, treat outside-click as a no-op so a misclick does
			// not throw away their work. Cancel and Escape still dismiss.
			// Drafts are persisted on input, so even if the composer dies the
			// text is recoverable, but keeping it visible avoids the surprise.
			const textarea = view.dom.querySelector<HTMLTextAreaElement>(
				".annoteca-reply-composer-textarea",
			);
			if (textarea && textarea.value.length > 0) return false;
			view.dispatch({ effects: setReplyComposerEffect.of(null) });
			return false;
		},
	});
}

// Tiny ref so dismissReplyOnOutsideClick can read the state field without a
// circular import between the field constructor and the handler.
const replyComposerStateRef: { field: StateField<number | null> } = {
	field: undefined as unknown as StateField<number | null>,
};

function clickHandlerExtension(ctx: DecorationContext, field: StateField<Comment[]>): Extension {
	return EditorView.domEventHandlers({
		click: (event, view) => {
			if (hideAllFlag.value) return false;
			const target = event.target as HTMLElement | null;
			if (!target) return false;
			const markerEl = target.closest(".annoteca-marker, .annoteca-icon");
			if (!markerEl) return false;
			if (event.button !== 0) return false;
			const startAttr = markerEl.getAttribute("data-annoteca-marker-start");
			if (!startAttr) return false;
			const start = Number.parseInt(startAttr, 10);
			if (Number.isNaN(start)) return false;
			const markers = view.state.field(field);
			const m = markers.find(c => c.marker.start === start);
			if (!m) return false;
			ctx.onMarkerClick(m);
			event.preventDefault();
			event.stopPropagation();
			return true;
		},
	});
}

// --------------------------------------------------------------------------
// Line decorations for gutter-style markers. CM6's gutter() extension does
// not render reliably in Obsidian's Live Preview mode (the gutter container
// is hidden by Obsidian's CSS unless line numbers are enabled, and even
// then it does not always show custom gutters). Instead, we tag each line
// containing a marker with a CSS class and use a ::before pseudo-element
// positioned in the line's left margin via negative `left` to render the
// colored dot. The pseudo-element is non-interactive — clicks happen on
// the inline marker icon as usual.
// --------------------------------------------------------------------------

function lineMarkersCompute(ctx: DecorationContext, field: StateField<Comment[]>): Extension {
	return EditorView.decorations.compute([field], state => {
		if (hideAllFlag.value) return Decoration.none;
		const settings = ctx.getSettings();
		if (settings.indicatorStyle === "inline" || settings.indicatorStyle === "none") {
			return Decoration.none;
		}
		const markers = state.field(field);
		if (markers.length === 0) return Decoration.none;

		// Group markers by the line they sit on. First marker on each line
		// determines the dot color (the most common case is one marker per
		// line; multi-marker lines pick the first marker's category and
		// ignore subsequent for the dot, which keeps the visual simple).
		const byLine = new Map<number, Comment[]>();
		const doc = state.doc;
		for (const m of markers) {
			const line = doc.lineAt(m.marker.start);
			const arr = byLine.get(line.from) ?? [];
			arr.push(m);
			byLine.set(line.from, arr);
		}

		const decos: Range<Decoration>[] = [];
		const sortedStarts = Array.from(byLine.keys()).sort((a, b) => a - b);
		for (const lineStart of sortedStarts) {
			const lineMarkers = byLine.get(lineStart);
			if (!lineMarkers || lineMarkers.length === 0) continue;
			const first = lineMarkers[0];
			if (!first) continue;
			const allResolved = lineMarkers.every(m => m.resolution !== undefined);
			const cls = [
				"annoteca-line-with-marker",
				`annoteca-cat-${first.category}`,
			];
			if (allResolved) cls.push("annoteca-resolved");
			decos.push(
				Decoration.line({ class: cls.join(" ") }).range(lineStart),
			);
		}
		return Decoration.set(decos, true);
	});
}

export function buildAnnotecaExtension(ctx: DecorationContext): Extension {
	const field = markerStateField(ctx);
	const replyField = replyComposerField(ctx, field);
	replyComposerStateRef.field = replyField;
	return [
		field,
		replyField,
		// Render tooltips into document.body instead of the editor's DOM so
		// they can escape the sidebar leaf bounds. Without this override,
		// markers near the right edge of a narrow sidebar leaf produce a
		// vertically tall, horizontally squeezed popup because CodeMirror
		// shrinks the tooltip to fit available leaf width.
		tooltips({ parent: activeDocument.body }),
		decorationsCompute(ctx, field),
		lineMarkersCompute(ctx, field),
		hoverTooltipExtension(ctx, field),
		clickHandlerExtension(ctx, field),
		dismissReplyOnOutsideClick(),
	];
}

// Helper used by main.ts when registering navigation commands. Pure over the
// editor document.
export function findMarkersInDoc(content: string): Comment[] {
	return parseAll(content);
}
