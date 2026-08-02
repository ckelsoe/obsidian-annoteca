// Minimal Obsidian module stub for Jest. Provides empty class/function
// shims so non-test modules that `import { ... } from "obsidian"` can be
// loaded under Node without the real plugin host present. Tests that
// exercise pure helpers (parser, scope dispatch, color conversion,
// heading bucketing) only need the imports to resolve — they never call
// these stubs.

export class ItemView {}
export class WorkspaceLeaf {}
export class TFile {}
export class MarkdownView {}
export class Modal {}
export class App {}
export class Notice {
	constructor(_message?: string) {
		// no-op
	}
}
export class Menu {}
export class Plugin {}
export class Events {
	on(_name: string, _cb: (...args: unknown[]) => void): { name: string } {
		return { name: _name };
	}
	off(): void {
		// no-op
	}
	trigger(): void {
		// no-op
	}
	offref(): void {
		// no-op
	}
}

// Mirrors the shape of Obsidian's `Platform` that this plugin reads. Mutable
// on purpose: tests that cover per-platform behaviour flip these and restore
// them afterwards, which is why `platform.ts` reads the object per call instead
// of capturing a boolean at import time.
export const Platform = {
	isMobile: false,
	isPhone: false,
	isTablet: false,
	// `isDesktop` is UI mode and `isDesktopApp` is the Electron runtime. They are
	// separate fields here rather than one flag precisely so a test can set them
	// apart and catch code that confuses the two.
	isDesktop: true,
	isDesktopApp: true,
	isMobileApp: false,
};

export function setIcon(_el: HTMLElement, _icon: string): void {
	// no-op
}

export function getIconIds(): string[] {
	return [];
}

export function getAllTags(): string[] | null {
	return null;
}
