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

export function setIcon(_el: HTMLElement, _icon: string): void {
	// no-op
}

export function getIconIds(): string[] {
	return [];
}

export function getAllTags(): string[] | null {
	return null;
}
