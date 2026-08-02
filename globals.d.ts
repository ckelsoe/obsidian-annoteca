// Local type augmentations for the Obsidian API.
// Add type declarations here when the Obsidian types are missing or need extension.
// NEVER use `as any` to work around missing types. Add a proper declaration here instead.

import 'obsidian';
import type { EditorView } from '@codemirror/view';

declare global {
	// Obsidian installs createDiv/createSpan on every window, but obsidian.d.ts
	// declares them only as globals and on Node, not as members of the DOM
	// Window interface. Without this, the `someDocument.win.createDiv()` form
	// that obsidianmd/prefer-create-el asks for resolves as `any` and cascades
	// into no-unsafe-* errors. Declared here rather than cast at the call sites,
	// per the no-`as any` rule at the top of this file.
	interface Window {
		createDiv(o?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
		createSpan(o?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
	}
}

declare module 'obsidian' {
	interface PluginManifest {
		version: string;
	}

	// Obsidian's Markdown editor wraps a CodeMirror 6 EditorView accessible via
	// `editor.cm`. The official typings omit it.
	interface Editor {
		cm?: EditorView;
	}
}
