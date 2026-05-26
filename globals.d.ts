// Local type augmentations for the Obsidian API.
// Add type declarations here when the Obsidian types are missing or need extension.
// NEVER use `as any` to work around missing types. Add a proper declaration here instead.

import 'obsidian';
import type { EditorView } from '@codemirror/view';

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
