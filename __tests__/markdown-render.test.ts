/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seed\"></div></body></html>"}
 */

// Per-file jsdom, matching live-views.test.ts, so the other suites keep the
// lighter `node` environment they do not need a DOM for.
//
// These reach a real DOM but never a real Obsidian: renderCommentMarkdown takes
// the element it fills and uses only standard DOM APIs, so nothing here has to
// stand in for `createDiv` / `setText` / `addClass`.

import { Component, MarkdownRenderer, type App } from 'obsidian';

import {
	renderCommentMarkdown,
	cycleLifetime,
	MarkdownLifetime,
	type MarkdownRenderHost,
} from '../markdown-render';

const APP = {} as App;

function makeHost(
	overrides: Partial<MarkdownRenderHost> = {},
): MarkdownRenderHost {
	const component = new MarkdownLifetime();
	component.load();
	return {
		app: APP,
		component,
		sourcePath: 'notes/chapter.md',
		enabled: true,
		...overrides,
	};
}

// Fresh elements without calling any API the rulesets forbid. jsdom has no
// Obsidian DOM helpers, so `createDiv` does not exist here; obsidianmd's
// prefer-create-el forbids `document.createElement`; and @microsoft/sdl's
// no-inner-html forbids innerHTML / insertAdjacentHTML. What is left is to have
// the environment supply one element (the docblock above) and clone it, which
// uses only cloneNode and appendChild.
//
// Attached to the document because the post-render callback is gated on
// isConnected.
const SEED = document.getElementById('seed');

function div(): HTMLElement {
	if (!SEED) throw new Error('jsdom environment html did not provide #seed');
	// cloneNode is typed as returning Node; the seed is a div, so this is the
	// narrowing and not a claim about anything Obsidian owns.
	const el = SEED.cloneNode(false) as HTMLElement;
	el.removeAttribute('id');
	document.body.appendChild(el);
	return el;
}

// Lets the .then() on MarkdownRenderer.render settle.
const flush = (): Promise<void> => Promise.resolve().then(() => undefined);

let renderSpy: jest.SpyInstance;

beforeEach(() => {
	renderSpy = jest
		.spyOn(MarkdownRenderer, 'render')
		.mockResolvedValue(undefined);
	// replaceChildren rather than innerHTML: same effect, and it is a DOM call
	// rather than an HTML write, which @microsoft/sdl/no-inner-html flags.
	document.body.replaceChildren();
});

afterEach(() => {
	renderSpy.mockRestore();
});

describe('renderCommentMarkdown: when it renders and when it does not', () => {
	it('writes plain text and does not render with no host', () => {
		const el = div();
		renderCommentMarkdown(el, '**bold**', undefined);
		expect(el.textContent).toBe('**bold**');
		expect(el.classList.contains('annoteca-md')).toBe(false);
		expect(renderSpy).not.toHaveBeenCalled();
	});

	it('writes plain text and does not render when the setting is off', () => {
		const el = div();
		renderCommentMarkdown(el, '**bold**', makeHost({ enabled: false }));
		expect(el.textContent).toBe('**bold**');
		expect(el.classList.contains('annoteca-md')).toBe(false);
		expect(renderSpy).not.toHaveBeenCalled();
	});

	it('renders and marks the element when the setting is on', () => {
		const el = div();
		const host = makeHost();
		renderCommentMarkdown(el, '**bold**', host);
		expect(el.classList.contains('annoteca-md')).toBe(true);
		expect(renderSpy).toHaveBeenCalledTimes(1);
		expect(renderSpy).toHaveBeenCalledWith(
			APP,
			'**bold**',
			el,
			'notes/chapter.md',
			host.component,
		);
	});

	// The source path is what makes a wikilink in a body resolve against the note
	// the comment lives in rather than whatever is active.
	it('passes the host source path through to the renderer', () => {
		const el = div();
		renderCommentMarkdown(
			el,
			'[[Some Note]]',
			makeHost({ sourcePath: 'other/file.md' }),
		);
		expect(renderSpy).toHaveBeenCalledWith(
			APP,
			'[[Some Note]]',
			el,
			'other/file.md',
			expect.anything(),
		);
	});

	it('does not spend a render on an empty or whitespace-only body', () => {
		const empty = div();
		renderCommentMarkdown(empty, '', makeHost());
		const blank = div();
		renderCommentMarkdown(blank, '   \n  ', makeHost());
		expect(renderSpy).not.toHaveBeenCalled();
		expect(empty.classList.contains('annoteca-md')).toBe(false);
	});

	it('returns the element it was given', () => {
		const el = div();
		expect(renderCommentMarkdown(el, 'text', makeHost())).toBe(el);
	});
});

describe('renderCommentMarkdown: the post-render callback', () => {
	it('fires once the render settles, for an element in the document', async () => {
		const el = div();
		const onRendered = jest.fn();
		renderCommentMarkdown(el, '# heading', makeHost({ onRendered }));

		expect(onRendered).not.toHaveBeenCalled(); // async, not synchronous
		await flush();
		expect(onRendered).toHaveBeenCalledTimes(1);
	});

	// A hover tooltip dismisses on mouse-out and a panel pass empties its
	// container, either of which can happen while a render is still in flight.
	// Repositioning a tooltip that is already gone is at best wasted work.
	it('does not fire when the element left the document first', async () => {
		const el = div();
		const onRendered = jest.fn();
		renderCommentMarkdown(el, '# heading', makeHost({ onRendered }));

		el.remove();
		await flush();
		expect(onRendered).not.toHaveBeenCalled();
	});

	it('is optional', async () => {
		const el = div();
		renderCommentMarkdown(el, 'text', makeHost());
		await expect(flush()).resolves.toBeUndefined();
	});
});

// The leak this guards against: every panel re-render and every hover creates a
// component, and nothing else unloads them.
describe('markdown render lifetimes', () => {
	it('cycleLifetime unloads the previous one and loads a fresh one', () => {
		const loadSpy = jest.spyOn(MarkdownLifetime.prototype, 'load');
		const unloadSpy = jest.spyOn(MarkdownLifetime.prototype, 'unload');
		try {
			const first = cycleLifetime(undefined);
			expect(loadSpy).toHaveBeenCalledTimes(1);
			expect(unloadSpy).not.toHaveBeenCalled();

			const second = cycleLifetime(first);
			expect(unloadSpy).toHaveBeenCalledTimes(1);
			expect(loadSpy).toHaveBeenCalledTimes(2);
			expect(second).not.toBe(first);
		} finally {
			loadSpy.mockRestore();
			unloadSpy.mockRestore();
		}
	});

	it('handles the first call, with nothing to unload', () => {
		expect(() => cycleLifetime(undefined)).not.toThrow();
	});

	it('a lifetime is a Component, so Obsidian can own its children', () => {
		expect(new MarkdownLifetime()).toBeInstanceOf(Component);
	});
});
