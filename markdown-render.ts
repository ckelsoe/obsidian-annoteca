// Renders comment bodies, replies and notes as markdown (#6). One entry point
// so every surface that shows freeform text agrees on how it is drawn, on the
// plain-text fallback, and on component lifetime.
//
// `types.ts` has declared the body "freeform inline markdown" since the format
// was written, and the manifest sells threaded AI conversations. Assistants emit
// markdown by default, so the flagship workflow reliably produced bodies that
// displayed as raw source: literal asterisks, backticks and `- ` bullets.
//
// Deliberately NOT used by the inline body widget in decorations.ts. That widget
// draws a truncated body beside every marker in the document, and rendered
// headings and lists repeated down the page destroy the layout of the note being
// reviewed, which is the opposite of the bird's-eye view #4 asked for. It renders
// textContent on purpose and says so.

import { Component, MarkdownRenderer, type App } from 'obsidian';

export interface MarkdownRenderHost {
	app: App;
	// Owns the lifecycle of whatever the render creates: embeds, code-block
	// post-processors, anything another plugin injects. Every ephemeral surface
	// (a tooltip, a panel re-render) must give a component it later unloads, or
	// renders accumulate for as long as the vault stays open.
	component: Component;
	// Normalized path of the note the comment lives in. Resolves relative links
	// and wikilinks; an empty string still renders, it just cannot resolve them.
	sourcePath: string;
	// The user setting. Carried on the host rather than checked by each caller
	// so there is one gate instead of three drifting copies.
	enabled: boolean;
	// Fires after a render settles, if the element is still in the document.
	// Lives on the host rather than as a per-call argument because it is a
	// property of the SURFACE, not of any one body: a CodeMirror tooltip sizes
	// and positions itself synchronously, so every render inside one has to
	// re-measure it, and threading a callback through each call site is how one
	// of them ends up forgotten.
	onRendered?: () => void;
}

// Fill `el` with `markdown`, rendered, or set it as plain text when rendering
// is off. Returns `el` so call sites can stay one expression.
//
// Takes the element rather than creating it so this module needs no Obsidian
// DOM helpers (`createDiv`, `setText`, `addClass`), which exist only inside a
// running Obsidian and are the reason a unit test would otherwise have to stand
// a hand-written imitation of Obsidian between itself and the code. Callers keep
// using createDiv, where they are already doing DOM construction anyway.
export function renderCommentMarkdown(
	el: HTMLElement,
	markdown: string,
	host: MarkdownRenderHost | undefined,
): HTMLElement {
	if (!host?.enabled || markdown.trim() === '') {
		el.textContent = markdown;
		return el;
	}
	el.classList.add('annoteca-md');
	void MarkdownRenderer.render(
		host.app,
		markdown,
		el,
		host.sourcePath,
		host.component,
	).then(() => {
		// The surface can be gone by now: a hover tooltip dismisses on mouse-out
		// and a panel re-render empties its container, either of which can happen
		// while the render is still in flight.
		if (!el.isConnected) return;
		host.onRendered?.();
	});
	return el;
}

// A Component whose only job is to own one surface's renders and be unloaded
// when that surface goes away. `Component` is concrete, so this is really just a
// named construction site: `new MarkdownLifetime()` at a call site reads as an
// object with a purpose, where a bare `new Component()` reads as a mystery.
export class MarkdownLifetime extends Component {}

// Replace a surface's previous render lifetime with a fresh one, unloading the
// old. Panels re-render on every index-changed event, which on an active vault
// is often; without this each pass would leave its children loaded forever.
export function cycleLifetime(
	previous: MarkdownLifetime | undefined,
): MarkdownLifetime {
	previous?.unload();
	const next = new MarkdownLifetime();
	next.load();
	return next;
}
