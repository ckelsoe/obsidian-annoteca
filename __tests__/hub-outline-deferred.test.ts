/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><h4></h4><div></div><span></span><button></button><p></p></div></body></html>"}
 */
// M12a: the Outline tab marks the cursor's heading even when the note is showing
// in a tab restored from a saved workspace and never activated. Such a leaf holds
// a DeferredView with no editor, so the synchronous render cannot read the cursor
// on the first pass; it loads the leaf once and re-renders, and the second pass
// marks the heading. Guarded to one load attempt per path so a failed load cannot
// loop.
import { MarkdownView, TFile } from 'obsidian';
import type { App } from 'obsidian';

import { installObsidianDomHelpers } from '../__mocks__/obsidian';
import { OutlineTabRenderer } from '../hub-outline-tab';
import type AnnotecaPlugin from '../main';

// Once per file: the installer removes the #seeds scaffolding after cloning it,
// and the jsdom document persists across tests in the file.
beforeAll(() => {
	installObsidianDomHelpers();
});

const HEADINGS = [
	{ heading: 'Intro', level: 1, position: { start: { offset: 0 } } },
	{ heading: 'Details', level: 2, position: { start: { offset: 100 } } },
];

// A markdown leaf whose view starts deferred (a plain object, not a
// MarkdownView) and becomes a real MarkdownView with a cursor once loaded.
function makeDeferredLeaf(cursorOffset: number) {
	const editor = {
		getCursor: () => ({ line: 0, ch: cursorOffset }),
		posToOffset: (p: { ch: number }) => p.ch,
	};
	const leaf: { view: unknown; load: () => void } = {
		view: {},
		load() {
			leaf.view = Object.assign(Object.create(MarkdownView.prototype), {
				editor,
			});
		},
	};
	return leaf;
}

function makePlugin(
	leaf: ReturnType<typeof makeDeferredLeaf>,
	opts: { loadSucceeds?: boolean } = {},
) {
	let ensureCalls = 0;
	const file = Object.assign(new TFile(), { path: 'a.md', basename: 'a' });
	const plugin = {
		commentIndex: { get: () => ({ comments: [] }) },
		findMarkdownLeafForPath: () => leaf,
		ensureLeafLoadedForPath: () => {
			ensureCalls += 1;
			const ok = opts.loadSucceeds ?? true;
			if (ok) leaf.load();
			return Promise.resolve(ok);
		},
		navigateToComment: () => Promise.resolve(),
		navigateToOffset: () => Promise.resolve(),
	} as unknown as AnnotecaPlugin;
	const app = {
		workspace: { getActiveFile: () => file },
		metadataCache: { getFileCache: () => ({ headings: HEADINGS }) },
	} as unknown as App;
	return { plugin, app, ensureCalls: () => ensureCalls };
}

describe('Outline tab: cursor heading for a deferred leaf (M12a)', () => {
	it('marks the cursor heading after loading the leaf and re-rendering', async () => {
		const leaf = makeDeferredLeaf(100); // cursor in the second heading
		const { plugin, app } = makePlugin(leaf);
		const container = document.body.createDiv();

		let renderedAgain: () => void = () => undefined;
		const rerender = new Promise<void>((r) => (renderedAgain = r));
		const renderer = new OutlineTabRenderer(plugin, app, () => {
			container.replaceChildren();
			renderer.render(container);
			renderedAgain();
		});

		// First pass: the leaf is deferred, so nothing is marked yet.
		renderer.render(container);
		expect(container.querySelector('.is-current')).toBeNull();

		// The async load resolves and re-renders; now the cursor heading is marked.
		await rerender;
		const current = container.querySelector('.is-current');
		expect(current?.textContent).toContain('Details');
	});

	it('attempts the load only once even across repeated renders', async () => {
		const leaf = makeDeferredLeaf(100);
		const { plugin, app, ensureCalls } = makePlugin(leaf, {
			loadSucceeds: false,
		});
		const container = document.body.createDiv();
		const renderer = new OutlineTabRenderer(plugin, app, () => undefined);

		renderer.render(container);
		container.replaceChildren();
		renderer.render(container);
		container.replaceChildren();
		renderer.render(container);
		await Promise.resolve();

		// The leaf stays deferred (the load failed), and the one-shot guard keeps
		// every later render from re-firing it.
		expect(ensureCalls()).toBe(1);
		expect(container.querySelector('.is-current')).toBeNull();
	});
});
