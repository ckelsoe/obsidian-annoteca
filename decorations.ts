// CodeMirror 6 extension that decorates Annoteca markers in the editor and
// wires hover/click interactions back to the plugin. Implements F-031, F-032,
// F-033, F-034, F-037, F-038 from features.md.

import {
	StateField,
	RangeSetBuilder,
	StateEffect,
	type Extension,
	type Transaction,
} from "@codemirror/state";
import {
	Decoration,
	EditorView,
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

interface MarkerCacheEntry {
	docVersion: number;
	comments: Comment[];
}

const markerStateField = (ctx: DecorationContext) => StateField.define<Comment[]>({
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

function classListForMarker(c: Comment, ctxSettings: AnnotecaSettings): string {
	const classes = ["annoteca-marker", `annoteca-cat-${c.category}`];
	if (c.resolution) {
		if (ctxSettings.resolvedDisplay === "hide") classes.push("annoteca-resolved-hidden");
		else classes.push("annoteca-resolved");
	}
	return classes.join(" ");
}

function decorationsCompute(ctx: DecorationContext, field: StateField<Comment[]>): Extension {
	return EditorView.decorations.compute([field], state => {
		if (hideAllFlag.value) return Decoration.none;
		const markers = state.field(field);
		const settings = ctx.getSettings();
		if (settings.indicatorStyle === "none") return Decoration.none;

		const builder = new RangeSetBuilder<Decoration>();
		for (const m of markers) {
			const cls = classListForMarker(m, settings);
			builder.add(
				m.marker.start,
				m.marker.end,
				Decoration.mark({
					class: cls,
					attributes: {
						"data-annoteca-marker-start": String(m.marker.start),
						"data-annoteca-marker-end": String(m.marker.end),
					},
				}),
			);
		}
		return builder.finish();
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
			const markerEl = target.closest(".annoteca-marker");
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

// Sentinel used by the StateField to bypass a no-op transaction. Exported for
// tests; ignored at runtime.
export const __markerCacheSentinel: MarkerCacheEntry = { docVersion: -1, comments: [] };
