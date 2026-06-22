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

import { setIcon } from "obsidian";

import type { Comment } from "./types";
import type { AnnotecaSettings } from "./types";
import { parseAll } from "./parser";
import {
	planActiveCommentDecorations,
	resolveAnchorRangeInWindows,
	ANCHOR_WINDOW,
	shouldSubmitOnKeydown,
} from "./view-utils";

export interface DecorationContext {
	getSettings(): AnnotecaSettings;
	onMarkerClick(marker: Comment): void;
	openInReviewer(marker: Comment): void;
	addCommentForSelection(): void;
	toggleResolution(marker: Comment): void;
	resolveAndRemove(marker: Comment): void;
	acceptAddressed(marker: Comment): void;
	reviseAddressed(marker: Comment): void;
	rejectAddressed(marker: Comment): void;
	copyPermalink(marker: Comment): void;
	submitReply(marker: Comment, body: string, author: string): void;
	getAuthorTag(): string;
	getAuthorOptions(): string[];
	authorColor(tag: string): string | undefined;
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

// Active-comment state (F-276). Carries the marker start of the comment whose
// thread is currently open in the side panel, or `null` when nothing is
// selected. The plugin dispatches this when the panel focuses a comment and
// clears it when the panel closes; the StateField below paints a background
// over the active comment so the reviewer never loses track of which marker the
// thread belongs to. Mirrors the reply-composer effect/field pair.
const setActiveCommentEffect = StateEffect.define<number | null>();

// Dispatch the active-comment highlight into a specific editor. `null` clears
// it. Called from main.ts on panel focus / close.
export function setActiveComment(view: EditorView, markerStart: number | null): void {
	view.dispatch({ effects: setActiveCommentEffect.of(markerStart) });
}

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
	constructor(
		private readonly marker: Comment,
		private readonly hidden: boolean,
		private readonly onClick: (marker: Comment) => void,
	) {
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
			&& o.resolution === m.resolution
			&& o.addressed === m.addressed
			&& other.hidden === this.hidden;
	}

	override toDOM(view: EditorView): HTMLElement {
		const el = view.dom.ownerDocument.createElement("span");
		el.className = `annoteca-icon annoteca-cat-${this.marker.category}`;
		el.setAttribute("data-annoteca-marker-start", String(this.marker.marker.start));
		el.setAttribute("data-annoteca-marker-end", String(this.marker.marker.end));
		if (this.marker.resolution) el.classList.add("annoteca-resolved");
		// F-270: an addressed comment (pending accept/revise/reject) gets a
		// distinct accent so the reviewer sees at a glance which markers the AI
		// has acted on. Resolved wins visually if somehow both are present.
		if (this.marker.addressed && !this.marker.resolution) el.classList.add("annoteca-addressed");
		if (this.hidden) el.classList.add("annoteca-resolved-hidden");
		if (this.marker.replies.length > 0) el.classList.add("annoteca-has-replies");
		el.title = `${this.marker.category}: ${this.marker.body.slice(0, 80)}`;
		// Single character for all marker states. Resolved status is conveyed
		// via the annoteca-resolved CSS class (opacity + strikethrough), not
		// a different character — switching shapes (◆ vs ●) at small font
		// sizes reads as visual noise rather than meaningful state.
		el.textContent = "◆";
		// Handle the click on the widget directly. A replaced widget that returns
		// true from ignoreEvent does NOT route its clicks to the editor's
		// domEventHandlers, so the icon would otherwise be unclickable (point
		// comments, which have only an icon and no underline, could not be opened
		// at all). The anchor underline is plain marked text and still goes
		// through the editor click handler. stopPropagation prevents a double
		// open if the event ever does bubble.
		el.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onClick(this.marker);
		});
		return el;
	}

	override ignoreEvent(event: Event): boolean {
		// Keep CM6 from treating a press on the icon as cursor placement (which
		// would move the cursor into the marker range). The icon handles its own
		// click via the listener in toDOM, so we do not depend on CM routing the
		// click to domEventHandlers (it does not, for a widget that ignores it).
		if (event.type === "mousedown" || event.type === "click") return true;
		return false;
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
function findAnchorRange(doc: import("@codemirror/state").Text, m: Comment): { from: number; to: number } | null {
	const a = m.anchor;
	if (!a) return null;
	const text = a.text;
	if (text.length === 0) return null;

	const markerStart = m.marker.start;
	const markerEnd = m.marker.end;
	const backStart = Math.max(0, markerStart - ANCHOR_WINDOW);
	const preceding = doc.sliceString(backStart, markerStart);
	const following = doc.sliceString(markerEnd, Math.min(doc.length, markerEnd + ANCHOR_WINDOW));

	return resolveAnchorRangeInWindows(
		preceding, backStart, markerStart, following, markerEnd, text,
	);
}

function anchorClassesFor(c: Comment, settings: AnnotecaSettings): string {
	const tier = resolveTier(c.category, settings);
	const classes = [
		"annoteca-anchor",
		`annoteca-cat-${c.category}`,
		`annoteca-anchor-tier-${tier}`,
	];
	if (c.resolution) classes.push("annoteca-resolved");
	return classes.join(" ");
}

function resolveTier(categoryId: string, settings: AnnotecaSettings): "subtle" | "normal" | "strong" {
	const def = settings.categories.find(c => c.id === categoryId);
	return def?.tier ?? "normal";
}

function decorationsCompute(ctx: DecorationContext, field: StateField<Comment[]>): Extension {
	return EditorView.decorations.compute([field, "selection"], state => {
		if (hideAllFlag.value) return Decoration.none;
		const markers = state.field(field);
		const settings = ctx.getSettings();
		if (settings.indicatorStyle === "none") return Decoration.none;

		const showIcon = settings.indicatorStyle === "icon" || settings.indicatorStyle === "both";
		const showUnderline = settings.indicatorStyle === "underline" || settings.indicatorStyle === "both";

		// Build a list sorted by start, since RangeSetBuilder requires monotone
		// order. parseAll returns markers in document order already, but sort
		// defensively in case the parser ever changes.
		const sorted = [...markers].sort((a, b) => a.marker.start - b.marker.start);

		// Two streams of decorations: anchor underlines (Decoration.mark, can
		// start before the marker) and marker icons (Decoration.replace at the
		// marker range itself). They go into the same sorted output but the
		// underline is emitted first when it starts earlier — CM6 requires
		// monotone start order.
		const decorations: Range<Decoration>[] = [];

		for (const m of sorted) {
			const isHidden = m.resolution !== undefined && settings.resolvedDisplay === "hide";

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
								"data-annoteca-anchor-for": String(m.marker.start),
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
					widget: new MarkerIconWidget(m, isHidden, (marker) => ctx.onMarkerClick(marker)),
					inclusive: false,
				}).range(m.marker.start, m.marker.end),
			);
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
function applyAuthorColor(el: HTMLElement, tag: string, ctx: DecorationContext): void {
	const color = ctx.authorColor(tag);
	if (!color) return;
	el.addClass("annoteca-author");
	el.style.setProperty("--annoteca-author-color", color);
}

function renderReplyRow(
	reply: { author: string; date: string; body: string },
	parent: HTMLElement,
	ctx: DecorationContext,
): void {
	const row = parent.createDiv({ cls: "annoteca-hover-reply" });
	const head = row.createDiv({ cls: "annoteca-hover-reply-head" });
	const authorEl = head.createSpan({ cls: "annoteca-hover-reply-author", text: reply.author });
	applyAuthorColor(authorEl, reply.author, ctx);
	head.createSpan({ cls: "annoteca-hover-reply-date", text: reply.date });
	row.createDiv({ cls: "annoteca-hover-reply-body", text: reply.body });
}

function hoverTooltipExtension(ctx: DecorationContext, field: StateField<Comment[]>): Extension {
	return hoverTooltip((view, pos): Tooltip | null => {
		if (hideAllFlag.value) return null;
		const settings = ctx.getSettings();
		if (settings.indicatorStyle === "none") return null;
		const markers = view.state.field(field);

		// Hover hits the marker range (where the inline icon lives).
		let m = markers.find(c => pos >= c.marker.start && pos <= c.marker.end);
		// Track the actual hovered range so the tooltip's source matches where
		// the mouse really is. If we report the marker range while the user is
		// actually over the anchor underline, CodeMirror dismisses the tooltip
		// the moment the mouse moves because it thinks the mouse already left
		// the source range — breaking the keepalive that lets users traverse
		// onto the popup.
		let hoverRange: { from: number; to: number } | undefined =
			m ? { from: m.marker.start, to: m.marker.end } : undefined;

		// Also accept hover anywhere over the anchor underline. The underline
		// sits before the marker range, so the marker-range find above misses
		// it. Only check when the underline is actually being rendered.
		if (!m && (settings.indicatorStyle === "underline" || settings.indicatorStyle === "both")) {
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
				} else if (m.addressed) {
					header.createSpan({ cls: "annoteca-hover-state annoteca-hover-state-addressed", text: "addressed" });
				}
				if (m.date) {
					header.createSpan({ cls: "annoteca-hover-date", text: m.date });
				}
				if (m.author) {
					const authorEl = header.createSpan({ cls: "annoteca-hover-author", text: m.author });
					applyAuthorColor(authorEl, m.author, ctx);
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
					for (const r of shown) renderReplyRow(r, repliesBlock, ctx);
				}

				// F-270/F-271/F-272: the addressed note, plus the verbatim original
				// when the edit replaced prose. The original is labeled "original
				// (replaced)" when the stored anchor no longer matches the document
				// (the expected post-replace state), and "original" otherwise.
				if (m.addressed) {
					const block = dom.createDiv({ cls: "annoteca-hover-addressed" });
					const head = block.createDiv({ cls: "annoteca-hover-resolution-head" });
					head.createSpan({ cls: "annoteca-hover-reply-author", text: m.addressed.author });
					head.createSpan({ cls: "annoteca-hover-reply-date", text: m.addressed.date });
					if (m.addressed.note) {
						block.createDiv({ cls: "annoteca-hover-reply-body", text: m.addressed.note });
					}
					if (m.addressed.original !== undefined) {
						const anchorResolves = findAnchorRange(view.state.doc, m) !== null;
						const label = anchorResolves ? "original" : "original (replaced)";
						const orig = block.createDiv({ cls: "annoteca-hover-original" });
						orig.createDiv({ cls: "annoteca-hover-original-label", text: label });
						orig.createDiv({ cls: "annoteca-hover-original-body", text: m.addressed.original });
					}
				}

				if (m.resolution && m.resolution.note) {
					const block = dom.createDiv({ cls: "annoteca-hover-resolution" });
					const head = block.createDiv({ cls: "annoteca-hover-resolution-head" });
					head.createSpan({ cls: "annoteca-hover-reply-author", text: m.resolution.author });
					head.createSpan({ cls: "annoteca-hover-reply-date", text: m.resolution.date });
					block.createDiv({ cls: "annoteca-hover-reply-body", text: m.resolution.note });
				}

				const actions = dom.createDiv({ cls: "annoteca-hover-actions" });

				// F-270: an addressed comment gets accept / revise / reject in
				// place of the plain resolve actions. Accept resolves it, revise
				// returns it to open for further editing, reject reverts the prose.
				if (m.addressed) {
					const acceptBtn = actions.createEl("button", {
						cls: "annoteca-hover-action mod-cta",
						text: "Accept",
					});
					acceptBtn.addEventListener("click", e => {
						e.preventDefault();
						e.stopPropagation();
						ctx.acceptAddressed(m);
					});
					const reviseBtn = actions.createEl("button", {
						cls: "annoteca-hover-action",
						text: "Revise",
					});
					reviseBtn.addEventListener("click", e => {
						e.preventDefault();
						e.stopPropagation();
						ctx.reviseAddressed(m);
					});
					const rejectBtn = actions.createEl("button", {
						cls: "annoteca-hover-action",
						text: "Reject",
					});
					rejectBtn.addEventListener("click", e => {
						e.preventDefault();
						e.stopPropagation();
						ctx.rejectAddressed(m);
					});
				}

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

				if (!m.addressed) {
					const resolveBtn = actions.createEl("button", {
						cls: "annoteca-hover-action",
						text: m.resolution ? "Reopen" : "Resolve",
					});
					resolveBtn.addEventListener("click", e => {
						e.preventDefault();
						e.stopPropagation();
						ctx.toggleResolution(m);
					});

					if (!m.resolution) {
						const resolveRemoveBtn = actions.createEl("button", {
							cls: "annoteca-hover-action",
							text: "Resolve and remove",
						});
						resolveRemoveBtn.addEventListener("click", e => {
							e.preventDefault();
							e.stopPropagation();
							ctx.resolveAndRemove(m);
						});
					}
				}

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

	// F-274: per-reply author picker. Options are the configured author tags plus
	// any authors already in this thread, so distinct collaborators can each sign
	// their own reply. Defaults to the configured author tag.
	const defaultAuthor = ctx.getAuthorTag();
	const threadAuthors = [m.author, ...m.replies.map(r => r.author)]
		.filter((a): a is string => typeof a === "string" && a.trim() !== "");
	const optionTags: string[] = [];
	const seenTags = new Set<string>();
	for (const tag of [defaultAuthor, ...ctx.getAuthorOptions(), ...threadAuthors]) {
		const t = tag.trim();
		if (t === "" || seenTags.has(t)) continue;
		seenTags.add(t);
		optionTags.push(t);
	}
	const authorLabel = head.createSpan({ cls: "annoteca-reply-composer-author", text: "as" });
	const authorSelect = authorLabel.createEl("select", { cls: "annoteca-reply-composer-author-select dropdown" });
	for (const tag of optionTags) authorSelect.createEl("option", { value: tag, text: tag });
	authorSelect.value = defaultAuthor;

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
		ctx.submitReply(m, body, authorSelect.value);
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
		} else if (shouldSubmitOnKeydown(e, ctx.getSettings().submitCommentOnEnter)) {
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
				".annoteca-reply-composer-textarea",
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
const replyComposerStateRef: { field?: StateField<number | null> } = {};

// --------------------------------------------------------------------------
// Active-comment highlight (F-276): a background mark over the comment whose
// thread is open in the side panel, so selecting a comment keeps it visually
// anchored in the editor.
// --------------------------------------------------------------------------

function activeCommentField(markersField: StateField<Comment[]>): StateField<number | null> {
	return StateField.define<number | null>({
		create: () => null,
		update(value, tr) {
			for (const e of tr.effects) {
				if (e.is(setActiveCommentEffect)) return e.value;
			}
			// Drop the highlight if the underlying marker no longer exists
			// (deleted, rewritten, or shifted by an edit that changed its start).
			if (tr.docChanged && value !== null) {
				const markers = tr.state.field(markersField);
				if (!markers.some(m => m.marker.start === value)) return null;
			}
			return value;
		},
	});
}

function activeCommentDecorations(
	markersField: StateField<Comment[]>,
	activeField: StateField<number | null>,
): Extension {
	return EditorView.decorations.compute([markersField, activeField], state => {
		const start = state.field(activeField);
		const markers = state.field(markersField);
		const m = start === null ? undefined : markers.find(c => c.marker.start === start);
		const anchorRange = m ? findAnchorRange(state.doc, m) : null;
		const specs = planActiveCommentDecorations(start, markers, anchorRange, hideAllFlag.value);
		if (specs.length === 0) return Decoration.none;
		return Decoration.set(
			specs.map(s => Decoration.mark({ class: s.cls }).range(s.from, s.to)),
			true,
		);
	});
}

function clickHandlerExtension(ctx: DecorationContext, field: StateField<Comment[]>): Extension {
	return EditorView.domEventHandlers({
		click: (event, view) => {
			if (hideAllFlag.value) return false;
			const target = event.target as HTMLElement | null;
			if (!target) return false;
			if (event.button !== 0) return false;

			const markerEl = target.closest(".annoteca-marker, .annoteca-icon, .annoteca-anchor");
			if (!markerEl) return false;

			// The icon/marker spans carry `data-annoteca-marker-start`. The
			// anchor underline spans carry `data-annoteca-anchor-for`, which
			// also stores the marker's start offset. Either resolves the same
			// way.
			const startAttr =
				markerEl.getAttribute("data-annoteca-marker-start") ??
				markerEl.getAttribute("data-annoteca-anchor-for");
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

// Selection popup: a small floating "Comment" button anchored at the end of a
// non-empty selection. Opt-in via settings.selectionPopup. Derived purely from
// selection state (no effect/field), so it appears and follows the selection as
// the user drags, and disappears when the selection collapses. Gives a one-
// click path to the composer without the right-click menu.
function selectionPopupExtension(ctx: DecorationContext): Extension {
	return showTooltip.compute(["selection"], state => {
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
	const dom = activeDocument.createElement("div");
	dom.addClass("annoteca-selection-popup");
	queueMicrotask(() => {
		const wrapper = dom.parentElement;
		if (wrapper) wrapper.addClass("annoteca-selection-popup-tooltip");
	});

	const btn = dom.createEl("button", {
		cls: "annoteca-selection-popup-button",
		attr: { type: "button", "aria-label": "Add comment for selection" },
	});
	const icon = btn.createSpan({ cls: "annoteca-selection-popup-icon" });
	setIcon(icon, "message-square-plus");
	btn.createSpan({ cls: "annoteca-selection-popup-label", text: "Comment" });

	// preventDefault on mousedown keeps the editor selection intact: without it,
	// pressing the button moves focus and collapses the selection before the
	// composer can read it.
	btn.addEventListener("mousedown", e => e.preventDefault());
	btn.addEventListener("click", () => ctx.addCommentForSelection());

	return { dom };
}

export function buildAnnotecaExtension(ctx: DecorationContext): Extension {
	const field = markerStateField(ctx);
	const replyField = replyComposerField(ctx, field);
	replyComposerStateRef.field = replyField;
	const activeField = activeCommentField(field);
	return [
		field,
		replyField,
		activeField,
		activeCommentDecorations(field, activeField),
		// Render tooltips into document.body instead of the editor's DOM so
		// they can escape the sidebar leaf bounds. Without this override,
		// markers near the right edge of a narrow sidebar leaf produce a
		// vertically tall, horizontally squeezed popup because CodeMirror
		// shrinks the tooltip to fit available leaf width.
		tooltips({ parent: activeDocument.body }),
		decorationsCompute(ctx, field),
		selectionPopupExtension(ctx),
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
