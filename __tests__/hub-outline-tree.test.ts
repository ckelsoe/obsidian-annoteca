/**
 * @jest-environment jsdom
 * @jest-environment-options {"html": "<html><body><div id=\"seeds\"><h4></h4><div></div><span></span><button></button><p></p></div></body></html>"}
 */
// The Outline tab as a tree: what it draws, and what each control does.

import { MarkdownView, TFile } from 'obsidian';
import type { App } from 'obsidian';

import { installObsidianDomHelpers } from '../__mocks__/obsidian';
import { OutlineTabRenderer } from '../hub-outline-tab';
import { CommentIndex } from '../index';
import { DEFAULT_SETTINGS } from '../settings';
import type AnnotecaPlugin from '../main';

const m = (body: string) => `<!-- annoteca/clarify: ${body} -->`;
const TEXT = [
	'# Title',
	'## To-do',
	`- review ${m('automate')} steps`,
	'- plain item',
	'## Notes',
	'Text.',
].join('\n');
const pos = (line: number, col = 0) => ({ line, col, offset: 0 });

function harness() {
	const index = new CommentIndex();
	index.rebuild('a.md', TEXT);
	const file = Object.assign(new TFile(), {
		path: 'a.md',
		basename: 'a',
		stat: { mtime: 1 },
	});
	const editor = {
		getCursor: () => ({ line: 0, ch: 0 }),
		posToOffset: () => TEXT.indexOf('## Notes') + 3,
		getValue: () => TEXT,
	};
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		editor,
	});
	const calls: string[] = [];
	const plugin = {
		settings: { ...DEFAULT_SETTINGS },
		commentIndex: index,
		findMarkdownLeafForPath: () => ({ view }),
		ensureLeafLoadedForPath: () => Promise.resolve(true),
		navigateToOffset: (_p: string, o: number) => {
			calls.push(`nav ${o}`);
			return Promise.resolve();
		},
		navigateToComment: () => Promise.resolve(),
		commentOnRange: (_p: string, from: number, to: number) => {
			calls.push(`comment ${TEXT.slice(from, to)}`);
			return Promise.resolve();
		},
		openReviewerOnComment: () => calls.push('thread'),
		openCommentInTab: () => calls.push('tab'),
	} as unknown as AnnotecaPlugin;
	const app = {
		workspace: { getActiveFile: () => file },
		metadataCache: {
			getFileCache: () => ({
				headings: [
					{ heading: 'Title', level: 1, position: { start: pos(0) } },
					{ heading: 'To-do', level: 2, position: { start: pos(1) } },
					{ heading: 'Notes', level: 2, position: { start: pos(4) } },
				],
				listItems: [
					{
						position: {
							start: pos(2),
							end: pos(2, TEXT.split('\n')[2]?.length),
						},
						parent: -2,
					},
					{
						position: { start: pos(3), end: pos(3, 12) },
						parent: -2,
					},
				],
			}),
		},
	} as unknown as App;
	const container = document.body.createDiv();
	const draw = () => {
		container.replaceChildren();
		renderer.render(container);
	};
	const renderer: OutlineTabRenderer = new OutlineTabRenderer(
		plugin,
		app,
		draw,
	);
	draw();
	return { container, calls, draw };
}

const labels = (c: HTMLElement) =>
	[...c.querySelectorAll('.annoteca-density-heading')].map(
		(e) => e.textContent,
	);
const row = (c: HTMLElement, label: string): HTMLElement => {
	const r = [
		...c.querySelectorAll<HTMLElement>('.annoteca-density-row'),
	].find(
		(e) =>
			e.querySelector('.annoteca-density-heading')?.textContent === label,
	);
	if (!r) throw new Error(`no row ${label}`);
	return r;
};
const toggle = (c: HTMLElement, label: string) =>
	c.querySelector<HTMLElement>(
		`.annoteca-outline-toggle[aria-label="${label}"]`,
	);

beforeAll(() => installObsidianDomHelpers());
afterEach(() => document.body.replaceChildren());

describe('Outline tree', () => {
	it('shows headings only by default, with counts rolled up', () => {
		const { container } = harness();
		expect(labels(container)).toEqual(['Title', 'To-do', 'Notes']);
		expect(row(container, 'Title').textContent).toContain('1 open');
		expect(row(container, 'To-do').textContent).toContain('1 open');
		expect(row(container, 'Notes').textContent).not.toContain('open');
		expect(container.querySelector('[role="tree"]')).not.toBeNull();
	});

	it('marks the heading the cursor is under', () => {
		const { container } = harness();
		expect(row(container, 'Notes').classList.contains('is-current')).toBe(
			true,
		);
	});

	it('List items adds the items, with the badge on the commented line', () => {
		const { container } = harness();
		toggle(container, 'List items')?.click();
		expect(labels(container)).toEqual([
			'Title',
			'To-do',
			'review steps',
			'plain item',
			'Notes',
		]);
		expect(
			row(container, 'review steps').querySelector(
				'.annoteca-outline-own',
			)?.textContent,
		).toBe('1');
	});

	it('Only with comments drops the lines that have none', () => {
		const { container } = harness();
		toggle(container, 'List items')?.click();
		toggle(container, 'Only with comments')?.click();
		expect(labels(container)).toEqual(['Title', 'To-do', 'review steps']);
	});

	it('a chevron collapses a branch and keeps its count', () => {
		const { container } = harness();
		toggle(container, 'List items')?.click();
		row(container, 'To-do')
			.querySelector<HTMLElement>('.annoteca-outline-chevron')
			?.click();
		expect(labels(container)).not.toContain('review steps');
		expect(row(container, 'To-do').getAttribute('aria-expanded')).toBe(
			'false',
		);
		expect(row(container, 'To-do').textContent).toContain('1 open');
	});

	it('clicking a row jumps to it and shows its comments', () => {
		const { container, calls } = harness();
		toggle(container, 'List items')?.click();
		row(container, 'review steps').click();
		expect(calls).toContain(`nav ${TEXT.indexOf('- review')}`);
		const card = container.querySelector('.annoteca-outline-card');
		expect(card?.textContent).toContain('automate');
		card?.querySelector<HTMLElement>('[aria-label="Open thread"]')?.click();
		expect(calls).toContain('thread');
	});

	it('comment on this line selects the line text, without markup or markers', () => {
		const { container, calls } = harness();
		toggle(container, 'List items')?.click();
		row(container, 'plain item')
			.querySelector<HTMLElement>('.annoteca-outline-add')
			?.click();
		expect(calls).toContain('comment plain item');
		row(container, 'To-do')
			.querySelector<HTMLElement>('.annoteca-outline-add')
			?.click();
		expect(calls).toContain('comment To-do');
	});

	it('works from the keyboard: Enter selects, arrows fold and unfold', () => {
		const { container, calls } = harness();
		toggle(container, 'List items')?.click();
		const todo = row(container, 'To-do');
		todo.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
		expect(labels(container)).not.toContain('review steps');
		row(container, 'To-do').dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowRight' }),
		);
		expect(labels(container)).toContain('review steps');
		row(container, 'Notes').dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter' }),
		);
		expect(calls).toContain(`nav ${TEXT.indexOf('## Notes')}`);
	});
});
