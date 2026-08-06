// The DOM helpers Obsidian injects onto the prototypes, for jsdom suites that
// drive code paths built on them. Installs ONLY what the paths under test
// call, and must stay a SUBSET of the real API, for the same reason
// `__mocks__/obsidian.ts` must: anything extra is an imitation of Obsidian
// standing between the test and the thing it verifies.
//
// Not named `*.test.ts` so Jest does not collect it as a suite.
//
// Elements are cloned from seeds the test file's jsdom `html` option supplies
// (a `#seeds` container holding one element per tag), because obsidianmd's
// prefer-create-el forbids `document.createElement` and the whole point of
// these helpers is to BE `createEl`. Cloning is the same dodge
// markdown-render.test.ts documents for its single div.

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
