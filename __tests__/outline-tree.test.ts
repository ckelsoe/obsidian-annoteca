// The Outline tab's tree model: nesting, which line a comment belongs to, the
// rolled-up counts, and the selectable text of each line.

import {
	buildOutlineTree,
	pruneToCommented,
	type HeadingInput,
	type ListItemInput,
	type OutlineNode,
} from '../outline-tree';
import { parseAll, scanClosers, serialize } from '../parser';
import type { MarkerRange } from '../types';

// A one-line marker, so each fixture line stays one line, the way the fake
// cache below reads it.
const c = (_id: string, body: string) => `<!-- annoteca/clarify: ${body} -->`;

// Headings and list items read off the text the way Obsidian's cache reports
// them, so each test states only the note.
function cacheOf(text: string): {
	headings: HeadingInput[];
	items: ListItemInput[];
} {
	const lines = text.split('\n');
	const headings: HeadingInput[] = [];
	const items: ListItemInput[] = [];
	const stack: { indent: number; line: number }[] = [];
	let listStart = -1;
	lines.forEach((l, i) => {
		const h = /^(#{1,6})\s/.exec(l);
		if (h?.[1]) {
			headings.push({ line: i, level: h[1].length });
			listStart = -1;
			stack.length = 0;
			return;
		}
		const m = /^(\s*)(?:[-*+]|\d+[.)])\s/.exec(l);
		if (!m) {
			if (l.trim() === '') {
				listStart = -1;
				stack.length = 0;
			}
			return;
		}
		const indent = m[1]?.length ?? 0;
		if (listStart === -1) listStart = i;
		while (
			stack.length > 0 &&
			(stack[stack.length - 1]?.indent ?? 0) >= indent
		)
			stack.pop();
		const parent = stack[stack.length - 1];
		items.push({
			startLine: i,
			startCol: indent,
			endLine: i,
			endCol: l.length,
			parent: parent ? parent.line : -listStart,
		});
		stack.push({ indent, line: i });
	});
	return { headings, items };
}

function tree(text: string, includeItems = true): OutlineNode[] {
	const { headings, items } = cacheOf(text);
	const comments = parseAll(text);
	const markers = comments.map((x) => x.marker);
	const occupied: MarkerRange[] = [...markers, ...scanClosers(text, markers)];
	return buildOutlineTree(
		text,
		headings,
		items,
		comments,
		occupied,
		includeItems,
	);
}

// "label (open/resolved)" per node, indented by depth.
function shape(nodes: readonly OutlineNode[], depth = 0): string[] {
	return nodes.flatMap((n) => [
		`${'  '.repeat(depth)}${n.label} (${n.openTotal}/${n.resolvedTotal})`,
		...shape(n.children, depth + 1),
	]);
}

describe('buildOutlineTree', () => {
	const NOTE = [
		'# Title',
		'Intro text.',
		'## To-do',
		`- review steps ${c('aaaa0001', 'automate')} 6 & 7`,
		'  - nested child',
		'## Roo Code',
		`Paragraph with a comment ${c('bbbb0002', 'tighten')} here.`,
		'- Failover',
		`- Stable URL ${c('cccc0003', 'x')}${c('dddd0004', 'y')}`,
		'### Deeper',
		'- leaf',
	].join('\n');

	it('nests headings by level and list items under their heading', () => {
		expect(shape(tree(NOTE))).toEqual([
			'Title (4/0)',
			'  To-do (1/0)',
			'    review steps 6 & 7 (1/0)',
			'      nested child (0/0)',
			'  Roo Code (3/0)',
			'    Failover (0/0)',
			'    Stable URL (2/0)',
			'    Deeper (0/0)',
			'      leaf (0/0)',
		]);
	});

	it('a comment in a paragraph belongs to the section heading', () => {
		const roo = tree(NOTE)[0]?.children[1];
		expect(roo?.own.map((x) => x.body)).toEqual(['tighten']);
	});

	it('counts roll up: open and resolved, own plus descendants', () => {
		// A resolved comment spans several lines, so this list item does too:
		// the item's span is given exactly, as Obsidian's cache reports it.
		const resolved = serialize({
			id: 'dddd0004',
			category: 'clarify',
			body: 'y',
			resolution: { author: 'ed', date: '2026-10-02', note: '' },
		});
		const text = `# A\n- Stable URL ${c('', 'x')}${resolved}\n- next`;
		const lines = text.split('\n');
		const itemEnd = lines.length - 2;
		const comments = parseAll(text);
		const markers = comments.map((x) => x.marker);
		const roots = buildOutlineTree(
			text,
			[{ line: 0, level: 1 }],
			[
				{
					startLine: 1,
					startCol: 0,
					endLine: itemEnd,
					endCol: lines[itemEnd]?.length ?? 0,
					parent: -1,
				},
				{
					startLine: itemEnd + 1,
					startCol: 0,
					endLine: itemEnd + 1,
					endCol: 6,
					parent: -1,
				},
			],
			comments,
			[...markers, ...scanClosers(text, markers)],
			true,
		);
		const stable = roots[0]?.children[0];
		expect(stable?.label).toBe('Stable URL');
		expect([stable?.openTotal, stable?.resolvedTotal]).toEqual([1, 1]);
		expect([roots[0]?.openTotal, roots[0]?.resolvedTotal]).toEqual([1, 1]);
	});

	it('headings only by default: item comments roll up to their heading', () => {
		expect(shape(tree(NOTE, false))).toEqual([
			'Title (4/0)',
			'  To-do (1/0)',
			'  Roo Code (3/0)',
			'    Deeper (0/0)',
		]);
	});

	it('labels drop markup and comment markers; the selectable span is the text', () => {
		const text = `- [ ] ${c('aaaa0001', 'x')} Buy the milk`;
		const node = tree(text)[0]?.children[0];
		expect(node?.label).toBe('Buy the milk');
		if (!node) return;
		expect(text.slice(node.textFrom, node.textTo)).toBe('Buy the milk');
		expect(node.task).toBeUndefined();
	});

	it('a comment before the first heading goes under a preamble node', () => {
		const text = `Lead ${c('aaaa0001', 'x')} in.\n# Title\nBody.`;
		const roots = tree(text);
		expect(roots[0]?.kind).toBe('preamble');
		expect(roots[0]?.openTotal).toBe(1);
		expect(roots[1]?.label).toBe('Title');
	});

	it('no preamble when nothing is before the first heading', () => {
		expect(tree('# Title\nBody.')[0]?.kind).toBe('heading');
	});

	it('works in editor offsets on a note whose lines the cache counts', () => {
		// Offsets come from line numbers, so they match the comment offsets
		// regardless of how the file on disk ends its lines.
		const text = `# A\n- one\n- two ${c('aaaa0001', 'x')}`;
		const two = tree(text)[0]?.children[1];
		expect(two?.own).toHaveLength(1);
	});

	it('pruneToCommented keeps only branches that hold comments', () => {
		expect(shape(pruneToCommented(tree(NOTE)))).toEqual([
			'Title (4/0)',
			'  To-do (1/0)',
			'    review steps 6 & 7 (1/0)',
			'  Roo Code (3/0)',
			'    Stable URL (2/0)',
		]);
	});

	it('a list that starts on line 0 keeps its top-level items as siblings', () => {
		// Obsidian gives a top-level item of such a list parent -0, which is
		// >= 0 and names line 0. Indentation tells it apart from a real child.
		const text = '- one\n- two\n  - child';
		const items: ListItemInput[] = [
			{ startLine: 0, startCol: 0, endLine: 0, endCol: 5, parent: -0 },
			{ startLine: 1, startCol: 0, endLine: 1, endCol: 5, parent: -0 },
			{ startLine: 2, startCol: 2, endLine: 2, endCol: 9, parent: 1 },
		];
		const roots = buildOutlineTree(text, [], items, [], [], true);
		const top = roots[0];
		expect(top?.kind).toBe('preamble');
		expect(top?.children.map((n) => n.label)).toEqual(['one', 'two']);
		expect(top?.children[1]?.children.map((n) => n.label)).toEqual([
			'child',
		]);
	});

	it('a comment inside a line limits the selectable span to before it', () => {
		const text = `- before ${c('', 'x')} after`;
		const node = tree(text)[0]?.children[0];
		if (!node) throw new Error('no node');
		expect(node.label).toBe('before after');
		expect(text.slice(node.textFrom, node.textTo)).toBe('before');
	});
});
