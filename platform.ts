// Single point of contact with Obsidian's `Platform` object.
//
// Two reasons this exists rather than importing `Platform` at each call site.
// First, the manifest declares `isDesktopOnly: false`, so per-platform
// decisions will accumulate (settings defaults, which affordances to render),
// and routing them through one module keeps them greppable instead of scattered
// across the UI layer. Second, `Platform` is a live object on the Obsidian
// global; wrapping it in functions means callers read it at the moment they
// need it rather than capturing a boolean at module load, which would be wrong
// on a tablet that has been re-docked.
//
// Prefer CSS breakpoints over these helpers for anything that is purely about
// available width. Use these only when the DECISION differs by platform, not
// merely the layout, because a narrow desktop window is not a phone.

import { Platform } from 'obsidian';

// True on both phones and tablets, matching Obsidian's own definition. This is
// the right check for "is there a pointer and a hover state", which is what
// most of the plugin's affordance decisions actually turn on.
export function isMobile(): boolean {
	return Platform.isMobile;
}

// Narrower than `isMobile`: excludes tablets. Reserved for decisions that are
// genuinely about a small screen rather than about touch input.
export function isPhone(): boolean {
	return Platform.isPhone;
}

// Whether HTML5 drag-and-drop can be expected to work. Touch devices never fire
// dragstart/dragover/drop, so any UI whose only reorder path is DnD is dead on
// mobile. Callers should offer a pointer-free alternative regardless, and use
// this only to decide whether ALSO showing the drag affordance is honest.
export function supportsDragAndDrop(): boolean {
	return !Platform.isMobile;
}
