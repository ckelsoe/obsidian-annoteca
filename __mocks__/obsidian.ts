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

// The DOM helpers Obsidian injects onto the prototypes, for jsdom suites that
// drive code paths BUILT from them (the reply composer, the tooltip host).
// Everything installed is a strict SUBSET of the real API, and elements are
// cloned from seeds the calling test's jsdom `html` option supplies (a
// `#seeds` container holding one element per tag), because obsidianmd's
// prefer-create-el forbids `document.createElement` and the whole point of
// these helpers is to BE `createEl`. Cloning is the same dodge
// markdown-render.test.ts documents for its single div.
//
// A module-level export reachable only through the relative import, like
// noticeLog above, so production code still types against the real
// obsidian.d.ts. Nothing here runs at import time, which keeps this file
// loadable in the node-environment suites that have no DOM.
export function installObsidianDomHelpers(): void {
	const seedsRoot = document.getElementById('seeds');
	if (!seedsRoot) {
		throw new Error(
			'installObsidianDomHelpers needs a #seeds element in the jsdom ' +
				'html option, holding one child element per tag the test creates',
		);
	}
	const seeds = new Map<string, HTMLElement>();
	// The type parameter is what the seeds ARE (children of a #seeds div in
	// the environment html), not a runtime check this installer could not make
	// before the helpers it installs exist.
	for (const el of seedsRoot.querySelectorAll<HTMLElement>('*')) {
		seeds.set(el.tagName.toLowerCase(), el);
	}
	// The seeds container is scaffolding, not part of any test's DOM.
	seedsRoot.remove();

	function cloneSeed<K extends keyof HTMLElementTagNameMap>(
		tag: K,
	): HTMLElementTagNameMap[K] {
		const seed = seeds.get(tag);
		if (!seed) {
			throw new Error(
				`no <${tag}> seed in #seeds; add one to the test's html option`,
			);
		}
		// cloneNode is typed as returning Node; the seed's tag was matched by
		// name, so this is the narrowing and not a claim about Obsidian's API.
		return seed.cloneNode(false) as HTMLElementTagNameMap[K];
	}

	function applyInfo(el: HTMLElement, o?: DomElementInfo | string): void {
		if (o === undefined) return;
		if (typeof o === 'string') {
			el.className = o;
			return;
		}
		if (o.cls !== undefined) {
			const classes = Array.isArray(o.cls) ? o.cls : o.cls.split(/\s+/);
			for (const c of classes) if (c !== '') el.classList.add(c);
		}
		if (typeof o.text === 'string') el.textContent = o.text;
		// As an attribute rather than a property write: the only caller in the
		// exercised path is `createEl('option', { value })`, and an option's
		// value attribute is what its value property reads.
		if (o.value !== undefined) el.setAttribute('value', o.value);
	}

	// One shared builder behind createEl / createDiv / createSpan, so the
	// wrappers are not themselves `createEl('div', ...)` calls.
	function create<K extends keyof HTMLElementTagNameMap>(
		parent: Node,
		tag: K,
		o?: DomElementInfo | string,
		callback?: (el: HTMLElementTagNameMap[K]) => void,
	): HTMLElementTagNameMap[K] {
		const el = cloneSeed(tag);
		applyInfo(el, o);
		parent.appendChild(el);
		callback?.(el);
		return el;
	}

	Node.prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
		this: Node,
		tag: K,
		o?: DomElementInfo | string,
		callback?: (el: HTMLElementTagNameMap[K]) => void,
	): HTMLElementTagNameMap[K] {
		return create(this, tag, o, callback);
	};
	Node.prototype.createDiv = function (
		this: Node,
		o?: DomElementInfo | string,
		callback?: (el: HTMLDivElement) => void,
	): HTMLDivElement {
		return create(this, 'div', o, callback);
	};
	Node.prototype.createSpan = function (
		this: Node,
		o?: DomElementInfo | string,
		callback?: (el: HTMLSpanElement) => void,
	): HTMLSpanElement {
		return create(this, 'span', o, callback);
	};
	Element.prototype.addClass = function (
		this: Element,
		...classes: string[]
	): void {
		for (const c of classes) if (c !== '') this.classList.add(c);
	};

	// `node.win`, which Obsidian defines on every Node. The tooltip host uses
	// it both through `ownerDocument.win` (a Document is a Node) and directly
	// on elements (`view.dom.win.setTimeout`). For a Document, ownerDocument
	// is null and the global document is the right fallback here: these
	// suites are single-realm, where the real helper resolves per window.
	Object.defineProperty(Node.prototype, 'win', {
		get(this: Node): Window {
			const doc = this.ownerDocument ?? document;
			return doc.defaultView ?? window;
		},
		configurable: true,
	});

	// Window-level detached creator: `win.createDiv()` returns an element that
	// the caller attaches itself (the composer root, the tooltip host).
	window.createDiv = (
		o?: DomElementInfo | string,
		callback?: (el: HTMLDivElement) => void,
	): HTMLDivElement => {
		const el = cloneSeed('div');
		applyInfo(el, o);
		callback?.(el);
		return el;
	};
}
