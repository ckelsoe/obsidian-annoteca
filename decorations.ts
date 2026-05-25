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
	type Tooltip,
} from "@codemirror/view";

import type { Comment } from "./types";
import type { AnnotecaSettings } from "./types";
import { parseAll } from "./parser";

export interface DecorationContext {
	getSettings(): AnnotecaSettings;
	onMarkerClick(marker: Comment): void;
}

// Module-level transient state. Editor open/close re-evaluates these. Toggling
// hide-all is a single global flag the StateField reads on every update.
const hideAllFlag = { value: false };

export const setHideAllCommentsEffect = StateEffect.define<boolean>();

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
		// Small bullet character; styled in CSS for size/color.
		el.textContent = this.marker.resolution ? "●" : "◆";
		return el;
	}

	override ignoreEvent(): boolean {
		// The plugin's editor click handler consumes the click via the
		// data-annoteca-marker-start attribute, so cm6 doesn't need to forward.
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
		if (r.from <= m.marker.end && r.to >= m.marker.start) return true;
	}
	return false;
}

function decorationsCompute(ctx: DecorationContext, field: StateField<Comment[]>): Extension {
	return EditorView.decorations.compute([field, "selection"], state => {
		if (hideAllFlag.value) return Decoration.none;
		const markers = state.field(field);
		const settings = ctx.getSettings();
		if (settings.indicatorStyle === "none") return Decoration.none;

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

				const body = m.body.length > 200 ? m.body.slice(0, 200) + "…" : m.body;
				dom.createDiv({ cls: "annoteca-hover-body", text: body });

				if (m.replies.length > 0) {
					dom.createDiv({
						cls: "annoteca-hover-replies",
						text: `${m.replies.length} repl${m.replies.length === 1 ? "y" : "ies"}`,
					});
				}

				return { dom };
			},
		};
	});
}

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

export function buildAnnotecaExtension(ctx: DecorationContext): Extension {
	const field = markerStateField(ctx);
	return [
		field,
		decorationsCompute(ctx, field),
		hoverTooltipExtension(ctx, field),
		clickHandlerExtension(ctx, field),
	];
}

// Helper used by main.ts when registering navigation commands. Pure over the
// editor document.
export function findMarkersInDoc(content: string): Comment[] {
	return parseAll(content);
}
