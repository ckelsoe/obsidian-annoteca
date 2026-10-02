// Outline tab renderer for the Annoteca hub. Shows the active note as a tree:
// its headings and, when turned on, its list items, each with the comments on
// that line and open/resolved counts rolled up from everything below it. The
// heading holding the editor's cursor is marked `.is-current`. Clicking a row
// jumps to it and shows its comments; each row can also start a comment that
// covers exactly that line.

import { MarkdownView, setIcon, TFile, type App } from 'obsidian';

import type AnnotecaPlugin from './main';
import type { Comment } from './types';
import { getCategoryOrFallback } from './categories';
import { resolveSettingsCategories } from './settings';
import { parseAll, scanClosers } from './parser';
import { hasUniqueId, truncate } from './view-utils';
import {
	buildOutlineTree,
	pruneToCommented,
	type OutlineNode,
} from './outline-tree';

export class OutlineTabRenderer {
	// The paths we have already kicked off a deferred-leaf load for, so a failed
	// load or an in-flight one cannot re-trigger every render and loop. A Set, not
	// one path: alternating between two files that each failed to load would
	// otherwise overwrite a single field and re-attempt each on return. A path is
	// removed once its leaf resolves to a real MarkdownView (the sync path below).
	private readonly deferredAttemptedPaths = new Set<string>();

	// A note's text when no editor holds it, keyed by path and stamped with the
	// file's mtime so an edit elsewhere is picked up. Loaded asynchronously, once
	// per change, and the tab re-renders when it arrives.
	private readonly texts = new Map<string, { mtime: number; text: string }>();
	private readonly loadingTexts = new Set<string>();

	// Per-session view state. List items are off by default, so the tab reads
	// as it always has until the reader asks for more.
	private showItems = false;
	private onlyCommented = false;
	// Row state is keyed by line position, which only means something inside
	// one note, so it is dropped whenever a different note is drawn. Kept
	// across notes, a collapsed heading at offset 0 in one note collapsed the
	// heading at offset 0 in the next.
	private readonly collapsed = new Set<string>();
	private selectedKey: string | undefined;
	// The row that holds keyboard focus. The tree has one tab stop (roving
	// focus), and a rebuild puts focus back on this row.
	private focusKey: string | undefined;
	private statePath: string | undefined;

	constructor(
		private readonly plugin: AnnotecaPlugin,
		private readonly app: App,
		private readonly requestRerender: () => void,
	) {}

	render(container: HTMLElement): void {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			this.renderEmpty(container, 'No file open.');
			return;
		}
		container.createEl('h4', { text: file.basename });
		if (this.statePath !== file.path) {
			this.statePath = file.path;
			this.collapsed.clear();
			this.selectedKey = undefined;
			this.focusKey = undefined;
		}

		const cache = this.app.metadataCache.getFileCache(file);
		const headings = cache?.headings ?? [];
		const idx = this.plugin.commentIndex.get(file.path);
		const comments = idx?.comments ?? [];

		// The cursor, for marking the current heading. Looks up the leaf
		// showing this file directly rather than getActiveViewOfType, which
		// returns null when the hub itself is the active leaf.
		//
		// A leaf restored from a saved workspace and never activated holds a
		// DeferredView with no `editor`, so this synchronous read cannot see the
		// cursor on the first render. When that is the case, load the leaf once
		// (loadedMarkdownView waits for the buffer to fill) and re-render; the
		// synchronous branch below then marks the heading. Guarded to one
		// attempt per path so a failed load cannot loop.
		const editorLeaf = this.plugin.findMarkdownLeafForPath(file.path);
		let cursor: number | undefined;
		let liveText: string | undefined;
		if (editorLeaf?.view instanceof MarkdownView) {
			this.deferredAttemptedPaths.delete(file.path);
			const editor = editorLeaf.view.editor;
			cursor = editor.posToOffset(editor.getCursor());
			liveText = editor.getValue();
		} else if (editorLeaf && !this.deferredAttemptedPaths.has(file.path)) {
			this.deferredAttemptedPaths.add(file.path);
			void this.plugin
				.ensureLeafLoadedForPath(file.path)
				.then((loaded) => {
					if (loaded) this.requestRerender();
				});
		}

		const text = liveText ?? this.cachedText(file);
		if (text === undefined) {
			this.renderEmpty(container, 'Loading the outline…');
			return;
		}
		const allItems = cache?.listItems ?? [];
		const listItems = this.showItems ? allItems : [];
		// Checked against the note's list items whether or not they are shown:
		// a note with lists and no headings needs the toolbar, or the toggle
		// that would show its lists can never be reached.
		if (headings.length === 0 && allItems.length === 0) {
			this.renderEmpty(
				container,
				`No headings. ${comments.length} comment(s) total.`,
			);
			return;
		}

		const markers = parseAll(text).map((c) => c.marker);
		const full = buildOutlineTree(
			text,
			headings.map((h) => ({
				line: h.position.start.line,
				level: h.level,
			})),
			listItems.map((li) => ({
				startLine: li.position.start.line,
				startCol: li.position.start.col,
				endLine: li.position.end.line,
				endCol: li.position.end.col,
				parent: li.parent,
				...(li.task !== undefined ? { task: li.task } : {}),
			})),
			comments,
			[...markers, ...scanClosers(text, markers)],
			this.showItems,
		);
		const roots = this.onlyCommented ? pruneToCommented(full) : full;

		this.renderToolbar(container);
		const current =
			cursor === undefined ? undefined : currentHeading(full, cursor);
		const tree = container.createDiv({
			cls: 'annoteca-outline-tree',
			attr: { role: 'tree', 'aria-label': `Outline of ${file.basename}` },
		});
		if (roots.length === 0) {
			this.renderEmpty(tree, 'No comments in this note.');
			return;
		}
		for (const n of roots) this.renderNode(tree, n, file, current, 0);
		this.wireKeyboard(tree);
	}

	// One tab stop for the whole tree, ArrowUp/ArrowDown between visible rows,
	// Home/End to the ends, and focus put back on the same row after the tree
	// is rebuilt. Each row's own keys (Enter, left/right) are wired in
	// renderNode.
	private wireKeyboard(tree: HTMLElement): void {
		const rows = Array.from(
			tree.querySelectorAll<HTMLElement>('.annoteca-density-row'),
		);
		const keyOf = (el: HTMLElement): string => el.dataset.key ?? '';
		const stop =
			rows.find((r) => keyOf(r) === this.focusKey) ??
			rows.find((r) => keyOf(r) === this.selectedKey) ??
			rows[0];
		for (const r of rows)
			r.setAttribute('tabindex', r === stop ? '0' : '-1');
		const move = (to: HTMLElement | undefined): void => {
			if (!to) return;
			for (const r of rows) r.setAttribute('tabindex', '-1');
			to.setAttribute('tabindex', '0');
			this.focusKey = keyOf(to);
			to.focus();
		};
		tree.addEventListener('keydown', (e) => {
			const at = rows.findIndex((r) => r === e.target);
			if (at === -1) return;
			const next =
				e.key === 'ArrowDown'
					? rows[at + 1]
					: e.key === 'ArrowUp'
						? rows[at - 1]
						: e.key === 'Home'
							? rows[0]
							: e.key === 'End'
								? rows[rows.length - 1]
								: undefined;
			if (!next) return;
			e.preventDefault();
			move(next);
		});
		tree.addEventListener('focusin', (e) => {
			const row = rows.find((r) => r === e.target);
			if (row) this.focusKey = keyOf(row);
		});
		const restore = rows.find((r) => keyOf(r) === this.focusKey);
		if (
			restore &&
			tree.ownerDocument.activeElement === tree.ownerDocument.body
		)
			restore.focus();
	}

	// The note's text for the version Obsidian's cache describes, or
	// undefined while it loads. Only a text read for the file's CURRENT mtime
	// is used: drawing new line positions over old text put rows, jumps and
	// "comment on this line" on the wrong words. A read that finishes after
	// the file changed again is thrown away, and the next render reads anew.
	private cachedText(file: TFile): string | undefined {
		const hit = this.texts.get(file.path);
		const mtime = file.stat?.mtime ?? 0;
		if (hit?.mtime === mtime) return hit.text;
		if (!this.loadingTexts.has(file.path)) {
			this.loadingTexts.add(file.path);
			void this.plugin.comments.currentNoteText(file.path, file).then(
				(note) => {
					this.loadingTexts.delete(file.path);
					if ((file.stat?.mtime ?? 0) === mtime)
						this.texts.set(file.path, { mtime, text: note.text });
					this.requestRerender();
				},
				() => {
					this.loadingTexts.delete(file.path);
				},
			);
		}
		return undefined;
	}

	private renderToolbar(container: HTMLElement): void {
		const bar = container.createDiv({ cls: 'annoteca-outline-toolbar' });
		const toggle = (
			label: string,
			icon: string,
			on: boolean,
			flip: () => void,
		): void => {
			const b = bar.createEl('button', {
				cls: `annoteca-outline-toggle${on ? ' is-active' : ''}`,
				attr: { 'aria-pressed': String(on), 'aria-label': label },
			});
			setIcon(
				b.createSpan({ cls: 'annoteca-outline-toggle-icon' }),
				icon,
			);
			b.createSpan({ text: label });
			b.addEventListener('click', () => {
				flip();
				this.requestRerender();
			});
		};
		toggle('List items', 'list', this.showItems, () => {
			this.showItems = !this.showItems;
		});
		toggle('Only with comments', 'list-filter', this.onlyCommented, () => {
			this.onlyCommented = !this.onlyCommented;
		});
	}

	private renderNode(
		parent: HTMLElement,
		n: OutlineNode,
		file: TFile,
		current: OutlineNode | undefined,
		depth: number,
	): void {
		const hasChildren = n.children.length > 0;
		const isCollapsed = this.collapsed.has(n.key);
		const selected = this.selectedKey === n.key;
		const row = parent.createDiv({
			cls: [
				'annoteca-density-row',
				`annoteca-outline-${n.kind}`,
				current === n ? 'is-current' : '',
				selected ? 'is-selected' : '',
			]
				.filter((c) => c !== '')
				.join(' '),
			attr: {
				role: 'treeitem',
				tabindex: '-1',
				'data-key': n.key,
				'data-depth': String(Math.min(depth, MAX_DEPTH)),
				'aria-level': String(depth + 1),
				'aria-selected': String(selected),
				...(hasChildren
					? { 'aria-expanded': String(!isCollapsed) }
					: {}),
				...(n.kind === 'heading'
					? { 'data-level': String(n.level) }
					: {}),
			},
		});

		const chevron = row.createSpan({ cls: 'annoteca-outline-chevron' });
		if (hasChildren) {
			setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
			chevron.addEventListener('click', (e) => {
				e.stopPropagation();
				this.toggleCollapsed(n.key);
			});
		}
		if (n.kind === 'heading')
			row.createSpan({
				cls: 'annoteca-outline-tag',
				text: `H${n.level}`,
			});
		else if (n.kind === 'item')
			row.createSpan({
				cls: 'annoteca-outline-bullet',
				text: n.task === undefined ? '•' : n.task === ' ' ? '☐' : '☑',
			});
		row.createSpan({
			cls: 'annoteca-density-heading',
			text: n.label === '' ? '(empty)' : n.label,
		});

		const counts = row.createSpan({ cls: 'annoteca-density-counts' });
		const ownOpen = n.own.filter((c) => !c.resolution).length;
		if (ownOpen > 0) {
			const badge = counts.createSpan({
				cls: 'annoteca-outline-own',
				attr: { 'aria-label': `${ownOpen} open on this line` },
			});
			setIcon(badge.createSpan(), 'message-square');
			badge.createSpan({ text: String(ownOpen) });
		}
		this.countButton(counts, n, file, 'open');
		this.countButton(counts, n, file, 'resolved');

		if (n.kind !== 'preamble') {
			const add = row.createEl('button', {
				cls: 'annoteca-outline-add clickable-icon',
				attr: { 'aria-label': 'Comment on this line' },
			});
			setIcon(add, 'message-square-plus');
			add.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.plugin.commentOnRange(
					file.path,
					n.textFrom,
					n.textTo,
				);
			});
		}

		const activate = (): void => {
			this.selectedKey = selected ? undefined : n.key;
			void this.plugin.navigateToOffset(file.path, n.start);
			this.requestRerender();
		};
		row.addEventListener('click', activate);
		row.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				activate();
			} else if (
				hasChildren &&
				(e.key === 'ArrowLeft' || e.key === 'ArrowRight')
			) {
				e.preventDefault();
				if ((e.key === 'ArrowLeft') !== isCollapsed)
					this.toggleCollapsed(n.key);
			}
		});

		if (selected && n.own.length > 0)
			this.renderPreview(parent, n, file, depth);
		if (hasChildren && !isCollapsed) {
			const group = parent.createDiv({
				cls: 'annoteca-outline-group',
				attr: { role: 'group' },
			});
			for (const ch of n.children)
				this.renderNode(group, ch, file, current, depth + 1);
		}
	}

	// "N open" / "N resolved" for the line and everything below it. A click
	// opens the first such comment, the same as the flat outline did.
	private countButton(
		counts: HTMLElement,
		n: OutlineNode,
		file: TFile,
		which: 'open' | 'resolved',
	): void {
		const total = which === 'open' ? n.openTotal : n.resolvedTotal;
		if (total === 0) return;
		const b = counts.createEl('button', {
			cls: `annoteca-density-${which} clickable`,
			text: `${total} ${which}`,
		});
		b.addEventListener('click', (e) => {
			e.stopPropagation();
			const first = firstComment(n, which);
			if (first)
				void this.plugin.navigateToComment(
					file.path,
					first.marker.start,
					first,
				);
		});
	}

	// The comments on a selected line, each with its first words and the ways
	// into it. The full thread lives in the Thread tab.
	private renderPreview(
		parent: HTMLElement,
		n: OutlineNode,
		file: TFile,
		depth: number,
	): void {
		const wrap = parent.createDiv({
			cls: 'annoteca-outline-preview',
			attr: { 'data-depth': String(Math.min(depth, MAX_DEPTH)) },
		});
		const enabled = resolveSettingsCategories(this.plugin.settings);
		const ordered = [...n.own].sort(
			(a, b) => Number(!!a.resolution) - Number(!!b.resolution),
		);
		for (const c of ordered) {
			const card = wrap.createDiv({
				cls: `annoteca-outline-card${c.resolution ? ' is-resolved' : ''}`,
			});
			const head = card.createDiv({ cls: 'annoteca-outline-card-head' });
			head.createSpan({
				cls: 'annoteca-outline-card-category',
				text: getCategoryOrFallback(c.category, enabled).displayName,
			});
			const meta = [
				c.author,
				c.replies.length > 0
					? `${c.replies.length} repl${c.replies.length === 1 ? 'y' : 'ies'}`
					: undefined,
				c.resolution ? 'resolved' : undefined,
			]
				.filter((x): x is string => x !== undefined)
				.join(' · ');
			if (meta !== '')
				head.createSpan({
					cls: 'annoteca-outline-card-meta',
					text: meta,
				});
			card.createDiv({
				cls: 'annoteca-outline-card-body',
				text: truncate(c.body, 140),
			});
			const acts = card.createDiv({
				cls: 'annoteca-outline-card-actions',
			});
			this.cardAction(acts, 'Open thread', 'messages-square', () =>
				this.plugin.openReviewerOnComment(c, file.path),
			);
			this.cardAction(acts, 'Go to text', 'locate', () => {
				void this.plugin.navigateToComment(
					file.path,
					c.marker.start,
					c,
				);
			});
			if (
				hasUniqueId(
					this.plugin.commentIndex.get(file.path)?.comments ?? [],
					c,
				)
			)
				this.cardAction(acts, 'Open in tab', 'app-window', () =>
					this.plugin.openCommentInTab(file.path, c),
				);
		}
	}

	private cardAction(
		parent: HTMLElement,
		label: string,
		icon: string,
		run: () => void,
	): void {
		const b = parent.createEl('button', {
			cls: 'annoteca-outline-card-action',
			attr: { 'aria-label': label },
		});
		setIcon(b.createSpan(), icon);
		b.createSpan({ text: label });
		b.addEventListener('click', (e) => {
			e.stopPropagation();
			run();
		});
	}

	private toggleCollapsed(key: string): void {
		if (this.collapsed.has(key)) this.collapsed.delete(key);
		else this.collapsed.add(key);
		this.requestRerender();
	}

	private renderEmpty(container: HTMLElement, message: string): void {
		container.createEl('p', { text: message, cls: 'annoteca-empty' });
	}
}

// Indentation steps styles.css has rules for. Deeper rows share the last step.
const MAX_DEPTH = 8;

// The innermost heading that starts at or before the cursor.
function currentHeading(
	nodes: readonly OutlineNode[],
	cursor: number,
): OutlineNode | undefined {
	let found: OutlineNode | undefined;
	const walk = (list: readonly OutlineNode[]): void => {
		for (const n of list) {
			if (n.kind === 'heading' && n.start <= cursor) found = n;
			walk(n.children);
		}
	};
	walk(nodes);
	return found;
}

// The first comment in document order on this line or below it.
function firstComment(
	n: OutlineNode,
	which: 'open' | 'resolved',
): Comment | undefined {
	const all: Comment[] = [];
	const walk = (m: OutlineNode): void => {
		all.push(...m.own);
		m.children.forEach(walk);
	};
	walk(n);
	return all
		.filter((c) => (which === 'open' ? !c.resolution : !!c.resolution))
		.sort((a, b) => a.marker.start - b.marker.start)[0];
}
