// The Outline tab's tree: a note's headings and, optionally, its list items,
// nested as the note nests them, with each comment attached to the line it is
// on and open/resolved counts rolled up to every ancestor. Pure over plain data
// so it is testable without Obsidian; the renderer feeds it Obsidian's cached
// headings and list items plus the note's editor text.
//
// Positions come in as LINE numbers, not offsets, and are turned into offsets
// against the editor text here. Obsidian's cache offsets count the raw file,
// where a Windows line ending is two characters, while every comment offset
// counts the editor text, where it is one. Comparing the two directly put
// comments under the wrong heading on a CRLF note.

import { SpanIndex } from './span-index';
import type { Comment, MarkerRange } from './types';

export interface HeadingInput {
	line: number;
	level: number;
}

export interface ListItemInput {
	startLine: number;
	startCol: number;
	endLine: number;
	endCol: number;
	// Obsidian's encoding: the parent item's start line, or the negated start
	// line of the list for a top-level item.
	parent: number;
	task?: string;
}

export interface OutlineNode {
	kind: 'heading' | 'item' | 'preamble';
	// Stable within one render: kind plus start offset.
	key: string;
	// The line's text with markdown markup and comment markers removed.
	label: string;
	// Heading level (1-6); for list items, the heading level of the section
	// they sit in plus their list depth, which is only used for indenting.
	level: number;
	// The text a "comment on this line" selects: the line's content after its
	// markup and any comment markers, in editor offsets.
	textFrom: number;
	textTo: number;
	// Where a click jumps to.
	start: number;
	task?: string;
	children: OutlineNode[];
	// Comments on this line itself.
	own: Comment[];
	// Open and resolved comments on this line and everything below it.
	openTotal: number;
	resolvedTotal: number;
}

const HEADING_PREFIX_RE = /^[ \t]{0,3}#{1,6}[ \t]+/;
const ITEM_PREFIX_RE =
	/^[ \t]*(?:>[ \t]?)*(?:[-*+]|\d+[.)])[ \t]+(?:\[[^\]\n]\][ \t]+)?/;

export function buildOutlineTree(
	text: string,
	headings: readonly HeadingInput[],
	listItems: readonly ListItemInput[],
	comments: readonly Comment[],
	occupied: readonly MarkerRange[],
	includeItems: boolean,
): OutlineNode[] {
	// Built once: filtering every marker and closer for every line was
	// quadratic in a long note with many comments.
	const cutIndex = new SpanIndex(occupied, (r) => r);

	const lineStarts = [0];
	for (let i = 0; i < text.length; i++)
		if (text.charAt(i) === '\n') lineStarts.push(i + 1);
	const lineStart = (line: number): number =>
		lineStarts[Math.min(Math.max(line, 0), lineStarts.length - 1)] ?? 0;
	const lineEnd = (line: number): number => {
		const next = lineStarts[line + 1];
		return next === undefined ? text.length : next - 1;
	};
	const offsetOf = (line: number, col: number): number =>
		Math.min(lineStart(line) + col, lineEnd(line));

	// One node per heading, and per list item when asked for.
	interface Draft {
		kind: 'heading' | 'item';
		level: number;
		task?: string;
		// The line's own text, before markup is stripped.
		from: number;
		to: number;
		// The span a comment must start in to belong to this line.
		spanFrom: number;
		spanTo: number;
		line: number;
		col: number;
		parentLine?: number;
	}
	const drafts: Draft[] = [];
	for (const h of headings) {
		const from = lineStart(h.line);
		const to = lineEnd(h.line);
		drafts.push({
			kind: 'heading',
			level: h.level,
			from,
			to,
			spanFrom: from,
			spanTo: to,
			line: h.line,
			col: 0,
		});
	}
	if (includeItems) {
		for (const li of listItems) {
			const from = offsetOf(li.startLine, li.startCol);
			const to = offsetOf(li.endLine, li.endCol);
			drafts.push({
				kind: 'item',
				level: 0,
				...(li.task !== undefined ? { task: li.task } : {}),
				from,
				to,
				spanFrom: lineStart(li.startLine),
				spanTo: to,
				line: li.startLine,
				col: li.startCol,
				...(li.parent >= 0 ? { parentLine: li.parent } : {}),
			});
		}
	}
	drafts.sort((a, b) => a.spanFrom - b.spanFrom || a.from - b.from);

	// An item's own text stops where the next line of the outline starts.
	// Obsidian's span for an item that continues after its children (a loose
	// list) covers those children too, so the row read its descendants' words
	// as its label, and "comment on this line" selected the whole subtree.
	// Every ancestor also re-read the same text, which was quadratic in a
	// deeply nested list. A child on the same line stops it at the child's
	// own text.
	const placed = drafts.map((d, i) => {
		const next = drafts[i + 1];
		let to = d.to;
		if (next && next.from > d.from)
			to = Math.min(
				to,
				next.spanFrom > d.from ? next.spanFrom : next.from,
			);
		const node = makeNode(d.kind, d.level, d.from, to);
		if (d.task !== undefined) node.task = d.task;
		return { ...d, node };
	});

	function makeNode(
		kind: 'heading' | 'item',
		level: number,
		from: number,
		to: number,
	): OutlineNode {
		const raw = text.slice(from, to);
		const prefix = (
			kind === 'heading' ? HEADING_PREFIX_RE : ITEM_PREFIX_RE
		).exec(raw)?.[0].length;
		const bodyFrom = from + (prefix ?? 0);
		const { label, textFrom, textTo } = cleanLine(bodyFrom, to);
		return {
			kind,
			key: `${kind}:${from}`,
			label,
			level,
			textFrom,
			textTo,
			start: from,
			children: [],
			own: [],
			openTotal: 0,
			resolvedTotal: 0,
		};
	}

	// The visible words of a line: markers and closers cut out, whitespace
	// collapsed, and the selectable span narrowed to start and end on text.
	function cleanLine(
		from: number,
		to: number,
	): { label: string; textFrom: number; textTo: number } {
		const cuts = cutIndex.overlapping(from, to);
		let label = '';
		let at = from;
		for (const r of cuts) {
			if (r.start > at) label += text.slice(at, r.start);
			at = Math.max(at, r.end);
		}
		if (at < to) label += text.slice(at, to);
		// First in start order wins, as a find over `cuts` did. Looked up,
		// not searched, so a line holding many markers stays linear.
		const byStart = new Map<number, MarkerRange>();
		const byEnd = new Map<number, MarkerRange>();
		for (const r of cuts) {
			if (!byStart.has(r.start)) byStart.set(r.start, r);
			if (!byEnd.has(r.end)) byEnd.set(r.end, r);
		}
		let textFrom = from;
		for (;;) {
			while (textFrom < to && /\s/.test(text.charAt(textFrom)))
				textFrom += 1;
			const m = byStart.get(textFrom);
			if (!m) break;
			textFrom = m.end;
		}
		// A comment already sitting inside the line splits it. The selectable
		// span stops before it, so a comment made from the row never wraps
		// another comment's marker text into its own range and anchor.
		const inner = cuts.find((r) => r.start > textFrom && r.start < to);
		let textTo = inner ? inner.start : to;
		for (;;) {
			while (textTo > textFrom && /\s/.test(text.charAt(textTo - 1)))
				textTo -= 1;
			const m = byEnd.get(textTo);
			if (!m) break;
			textTo = m.start;
		}
		return {
			label: label.replace(/\s+/g, ' ').trim(),
			textFrom,
			textTo: Math.max(textFrom, textTo),
		};
	}

	// Nest: headings by level, list items under their parent item, or under
	// the section heading they sit in. Content before the first heading goes
	// under a preamble node, created only if something lands there.
	const roots: OutlineNode[] = [];
	let preamble: OutlineNode | undefined;
	const headingStack: OutlineNode[] = [];
	const itemByLine = new Map<number, { node: OutlineNode; col: number }>();
	const preambleNode = (): OutlineNode => {
		if (!preamble) {
			preamble = {
				kind: 'preamble',
				key: 'preamble',
				label: 'Before the first heading',
				level: 0,
				textFrom: 0,
				textTo: 0,
				start: 0,
				children: [],
				own: [],
				openTotal: 0,
				resolvedTotal: 0,
			};
			roots.unshift(preamble);
		}
		return preamble;
	};
	for (const d of placed) {
		const n = d.node;
		if (n.kind === 'heading') {
			while (
				headingStack.length > 0 &&
				(headingStack[headingStack.length - 1]?.level ?? 0) >= n.level
			)
				headingStack.pop();
			const parent = headingStack[headingStack.length - 1];
			if (parent) parent.children.push(n);
			else roots.push(n);
			headingStack.push(n);
			continue;
		}
		const section = headingStack[headingStack.length - 1];
		// A parent must also be indented less than its child. Obsidian marks a
		// top-level item with the NEGATED line of its list's first item, and a
		// list that starts on line 0 gives -0, which reads as a real parent on
		// line 0: without this, the second top-level item nested under the
		// first.
		const candidate =
			d.parentLine === undefined
				? undefined
				: itemByLine.get(d.parentLine);
		const parentItem =
			candidate && candidate.col < d.col ? candidate.node : undefined;
		const parent = parentItem ?? section ?? preambleNode();
		n.level = parent.level + 1;
		parent.children.push(n);
		itemByLine.set(d.line, { node: n, col: d.col });
	}

	// Attach each comment to the line its marker starts on: the innermost
	// list item whose span holds it, else the section heading above it, else
	// the preamble.
	//
	// One sweep over comments in position order, not a walk of every draft
	// per comment, which was quadratic in a long outline. Spans only nest or
	// follow each other, so the drafts open at a position form a chain, kept
	// as a stack: the innermost one holding it is the top once the ones that
	// end before it are dropped. The holders are then filled in the comments'
	// own order.
	const holders = new Map<Comment, OutlineNode>();
	const stack: (typeof placed)[number][] = [];
	let heading: OutlineNode | undefined;
	let next = 0;
	const byPos = comments
		.map((c, i) => ({ c, i }))
		.sort((a, b) => a.c.marker.start - b.c.marker.start || a.i - b.i);
	for (const { c } of byPos) {
		const pos = c.marker.start;
		for (
			let d = placed[next];
			d !== undefined && d.spanFrom <= pos;
			d = placed[++next]
		) {
			while ((stack[stack.length - 1]?.spanTo ?? Infinity) < d.spanFrom)
				stack.pop();
			stack.push(d);
			if (d.node.kind === 'heading') heading = d.node;
		}
		while ((stack[stack.length - 1]?.spanTo ?? Infinity) < pos) stack.pop();
		holders.set(
			c,
			stack[stack.length - 1]?.node ?? heading ?? preambleNode(),
		);
	}
	for (const c of comments) holders.get(c)?.own.push(c);

	const total = (n: OutlineNode): void => {
		n.openTotal = n.own.filter((c) => !c.resolution).length;
		n.resolvedTotal = n.own.length - n.openTotal;
		for (const ch of n.children) {
			total(ch);
			n.openTotal += ch.openTotal;
			n.resolvedTotal += ch.resolvedTotal;
		}
	};
	for (const r of roots) total(r);
	return roots;
}

// The tree with every branch that holds no comments removed.
export function pruneToCommented(nodes: readonly OutlineNode[]): OutlineNode[] {
	const out: OutlineNode[] = [];
	for (const n of nodes) {
		if (n.openTotal + n.resolvedTotal === 0) continue;
		out.push({ ...n, children: pruneToCommented(n.children) });
	}
	return out;
}
