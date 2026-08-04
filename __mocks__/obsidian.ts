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
// Every Notice raised during a test, oldest first. A test imports this from
// '../__mocks__/obsidian' (a relative path, so it types against THIS file
// rather than obsidian.d.ts) and clears it in beforeEach.
//
// This is not a member added to a mocked class, which the Component note below
// rightly forbids: production code type-checks against the real obsidian.d.ts,
// so a convenience member there would compile under Jest and fail `npm run
// build`. A module-level export is only ever reachable through the relative
// import, so the mock stays a subset of the real API.
//
// It exists because the abort BEHAVIOUR was locked by tests while the
// user-facing message, which is the entire point of several of these paths, had
// no coverage at all: every noticeFileGone and noticeVanished call could be
// replaced with a no-op and the suite stayed green.
export const noticeLog: string[] = [];

export class Notice {
	constructor(message?: string) {
		if (message !== undefined) noticeLog.push(message);
	}
}
export class Menu {}
export class Plugin {}

// `markdown-render.ts` subclasses Component at module scope, so the base class
// has to exist for anything importing it (ui-helpers, decorations) to load.
//
// Deliberately no `loaded` flag, though it would make the lifetime tests read
// more naturally. Type-checking runs against the REAL obsidian.d.ts, where
// Component has no such member, so a convenience added here would compile under
// Jest and fail `npm run build`. The mock stays a subset of the real API; tests
// observe lifetimes by spying on load/unload instead.
export class Component {
	load(): void {
		// no-op
	}
	unload(): void {
		// no-op
	}
	addChild<T>(child: T): T {
		return child;
	}
	removeChild<T>(child: T): T {
		return child;
	}
	register(_cb: () => void): void {
		// no-op
	}
}

// Resolves immediately without touching the element. Tests here assert which
// surface asked for a render and that lifetimes are unloaded, never what
// Obsidian's markdown pipeline produces, which is not ours to reimplement.
export class MarkdownRenderer {
	static render(
		_app: unknown,
		_markdown: string,
		_el: HTMLElement,
		_sourcePath: string,
		_component: unknown,
	): Promise<void> {
		return Promise.resolve();
	}
}
// Needed so `settings.ts` can be imported for its DEFAULT_SETTINGS constant.
// The settings tab class is never constructed in tests, but the module's
// top-level `class AnnotecaSettingTab extends PluginSettingTab` is evaluated
// on import, so the base class has to exist.
export class PluginSettingTab {}
export class Setting {}
export class ButtonComponent {}
export function requireApiVersion(_version: string): boolean {
	return true;
}
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

// Obsidian installs this CodeMirror StateField on every markdown editor;
// decorations.ts reads it to find which file an editor holds. The suites build
// bare CodeMirror states without it and look it up with `field(..., false)`, so
// the value is never dereferenced here. It exists only so the import resolves.
export const editorInfoField = {};

export function setIcon(_el: HTMLElement, _icon: string): void {
	// no-op
}

export function getIconIds(): string[] {
	return [];
}

export function getAllTags(): string[] | null {
	return null;
}
