// Thread tab renderer for the Annoteca hub. Owns the scope toolbar,
// active-comment selection, per-session collapse state, file-group
// rendering, and the comment card (compact + expanded) inside the
// Thread tab. Public mutable fields `activePath` / `activeStart` are
// updated by the parent view's event handlers; the parent calls
// `render()` after writing them.

import { Notice, TFile, setIcon, type App } from 'obsidian';

import type AnnotecaPlugin from './main';
import type { Comment, ScopeState, StatusFilter } from './types';
import { getCategoryOrFallback } from './categories';
import { resolveSettingsCategories } from './settings';
import { nowISO } from './parser';
import {
	authorColorFor,
	authorPickerOptions,
	formatStamp,
	truncate,
	replyCountLabel,
} from './view-utils';
import {
	renderReplyRow,
	renderCategoryBadge,
	renderStarButton,
} from './ui-helpers';
import {
	renderCommentMarkdown,
	cycleLifetime,
	type MarkdownLifetime,
	type MarkdownRenderHost,
} from './markdown-render';

// Thread-tab class names for the shared reply-row renderer (ui-helpers). Author
// and date spans stay unclassed here, matching the prior inline markup; tinting
// comes from the author-color callback.
const THREAD_REPLY_CLASSES = {
	row: 'annoteca-reply',
	meta: 'annoteca-reply-meta',
	body: 'annoteca-reply-body',
};

export class ThreadTabRenderer {
	activePath: string | undefined;
	activeStart: number | undefined;
	// Per-session collapse state for file groups in multi-file Thread scopes.
	// Reset when the active file changes and autoCollapseInactiveFiles is on.
	private collapsedFilePaths = new Set<string>();
	private lastActiveFileForCollapse: string | undefined;
	// Per-session expand overrides for individual cards, keyed by path+start
	// (F-290). Absent key means the default applies: the active card auto-expands
	// and the rest stay compact. An explicit true/false is the user's chevron
	// choice; it persists across selection changes so several cards can stay open
	// at once on small screens.
	private cardExpandOverrides = new Map<string, boolean>();
	// The active card element from the latest render plus the selection key it was
	// last scrolled into view for, so reverse-sync (F-292) only scrolls the panel
	// when the selection actually changed, not on every refresh.
	private activeCardEl: HTMLElement | undefined;
	private lastScrolledActiveKey: string | undefined;
	// Owns the markdown renders of the CURRENT pass only. The panel re-renders
	// on every index-changed event, which on an active vault is constant, and
	// each pass empties the container; without cycling this, every render's
	// children would stay loaded for the life of the vault.
	private markdownLifetime: MarkdownLifetime | undefined;

	constructor(
		private readonly plugin: AnnotecaPlugin,
		private readonly app: App,
		private readonly refresh: () => void,
	) {}

	// Unloads the current render's markdown lifetime. Called when the hub view
	// closes; without it the last pass stays loaded after the panel is gone.
	dispose(): void {
		this.markdownLifetime?.unload();
		this.markdownLifetime = undefined;
	}

	// A render host bound to one card's file. Built per card rather than per
	// pass because a folder or vault scope shows comments from several files at
	// once, and a wikilink in a body has to resolve against the note the comment
	// lives in, not against whatever is active in the editor.
	private markdownHost(path: string): MarkdownRenderHost | undefined {
		const lifetime = this.markdownLifetime;
		if (!lifetime) return undefined;
		return {
			app: this.app,
			component: lifetime,
			sourcePath: path,
			enabled: this.plugin.settings.renderMarkdownBodies,
		};
	}

	render(container: HTMLElement): void {
		this.markdownLifetime = cycleLifetime(this.markdownLifetime);
		this.renderScopeToolbar(container);

		const scopeFiles = this.plugin.computeScopeFiles();
		if (scopeFiles.size === 0) {
			this.renderEmpty(container, 'No files in current scope.');
			return;
		}

		const groups = this.buildScopedGroups(scopeFiles);
		if (groups.length === 0) {
			this.renderEmpty(
				container,
				'No comments match this scope and filter.',
			);
			return;
		}

		this.selectActiveComment(groups);

		const showGroups = groups.length > 1;
		this.applyAutoCollapsePolicy(groups, showGroups);

		this.activeCardEl = undefined;
		const list = container.createDiv({ cls: 'annoteca-reviewer-list' });
		for (const group of groups) {
			if (showGroups) {
				this.renderFileGroup(list, group);
			} else {
				// Single-file scope: cards directly in the list, no header.
				for (const c of group.comments) {
					const isActive = c.marker.start === this.activeStart;
					const card = list.createDiv({
						cls: `annoteca-reviewer-card${isActive ? ' is-active' : ''}`,
					});
					this.renderCommentCard(card, c, group.path, isActive);
				}
			}
		}

		this.scrollActiveCardIntoView();
	}

	// Reverse sync (F-292): when the selection changes (e.g. a marker clicked in
	// the document), bring the now-active card into the panel viewport. Keyed on
	// the selection so ordinary refreshes (reply edits, star toggles) do not move
	// the panel. `block: "nearest"` leaves an already-visible card untouched.
	private scrollActiveCardIntoView(): void {
		const activeKey =
			this.activePath !== undefined && this.activeStart !== undefined
				? this.cardKey(this.activePath, this.activeStart)
				: undefined;
		if (
			activeKey &&
			activeKey !== this.lastScrolledActiveKey &&
			this.activeCardEl
		) {
			const el = this.activeCardEl;
			window.requestAnimationFrame(() =>
				el.scrollIntoView({ block: 'nearest' }),
			);
		}
		this.lastScrolledActiveKey = activeKey;
	}

	private cardKey(path: string, start: number): string {
		return `${path}\0${start}`;
	}

	// Effective expand state for a card: the user's explicit chevron override if
	// set, otherwise the default where only the active card is expanded (F-290).
	private isCardExpanded(
		path: string,
		start: number,
		isActive: boolean,
	): boolean {
		return (
			this.cardExpandOverrides.get(this.cardKey(path, start)) ?? isActive
		);
	}

	private buildScopedGroups(
		scopeFiles: Set<string>,
	): { path: string; comments: Comment[] }[] {
		const statusFilter = this.plugin.settings.statusFilter;
		const groups: { path: string; comments: Comment[] }[] = [];
		for (const p of [...scopeFiles].sort()) {
			const idx = this.plugin.commentIndex.get(p);
			if (!idx) continue;
			const filtered = idx.comments.filter((c) => {
				if (statusFilter === 'open') return !c.resolution;
				if (statusFilter === 'resolved')
					return c.resolution !== undefined;
				return true;
			});
			if (filtered.length > 0)
				groups.push({ path: p, comments: filtered });
		}
		return groups;
	}

	// Pick or validate the active comment. Identity is (path, start) — across
	// files a bare marker.start could collide. Default to the first comment in
	// the active file's group (if in scope), then fall back to the first group.
	private selectActiveComment(
		groups: { path: string; comments: Comment[] }[],
	): void {
		const activeFilePath = this.app.workspace.getActiveFile()?.path;
		const activeGroup = activeFilePath
			? groups.find((g) => g.path === activeFilePath)
			: undefined;
		const stillValid = groups.some(
			(g) =>
				g.path === this.activePath &&
				g.comments.some((c) => c.marker.start === this.activeStart),
		);
		if (!stillValid || this.activeStart === undefined) {
			const def = activeGroup?.comments[0] ?? groups[0]?.comments[0];
			const defGroup = activeGroup ?? groups[0];
			if (def && defGroup) {
				this.activePath = defGroup.path;
				this.activeStart = def.marker.start;
			}
		}
	}

	// We only reset the collapse set on active-file transitions so the user's
	// manual expand/collapse choices stick while they work in one file.
	private applyAutoCollapsePolicy(
		groups: { path: string; comments: Comment[] }[],
		showGroups: boolean,
	): void {
		const activeFileForCollapse =
			this.activePath ?? this.app.workspace.getActiveFile()?.path;
		if (
			showGroups &&
			this.plugin.settings.autoCollapseInactiveFiles &&
			activeFileForCollapse &&
			this.lastActiveFileForCollapse !== activeFileForCollapse
		) {
			this.collapsedFilePaths.clear();
			for (const g of groups) {
				if (g.path !== activeFileForCollapse)
					this.collapsedFilePaths.add(g.path);
			}
			this.lastActiveFileForCollapse = activeFileForCollapse;
		}
	}

	private renderFileGroup(
		list: HTMLElement,
		group: { path: string; comments: Comment[] },
	): void {
		const collapsed = this.collapsedFilePaths.has(group.path);
		const groupEl = list.createDiv({
			cls: `annoteca-file-group${collapsed ? ' is-collapsed' : ''}`,
		});
		this.renderFileHeader(groupEl, group, collapsed);
		if (collapsed) return;
		const body = groupEl.createDiv({ cls: 'annoteca-file-group-body' });
		for (const c of group.comments) {
			const isActive =
				group.path === this.activePath &&
				c.marker.start === this.activeStart;
			const card = body.createDiv({
				cls: `annoteca-reviewer-card${isActive ? ' is-active' : ''}`,
			});
			this.renderCommentCard(card, c, group.path, isActive);
		}
	}

	private renderFileHeader(
		container: HTMLElement,
		group: { path: string; comments: Comment[] },
		collapsed: boolean,
	): void {
		const file = this.app.vault.getAbstractFileByPath(group.path);
		const basename = file instanceof TFile ? file.basename : group.path;
		const open = group.comments.filter((c) => !c.resolution).length;
		const total = group.comments.length;
		const countText = open === total ? `${total}` : `${open}/${total}`;

		const header = container.createDiv({ cls: 'annoteca-file-header' });

		const chevron = header.createSpan({
			cls: 'annoteca-file-header-chevron',
		});
		setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');

		const fileIcon = header.createSpan({
			cls: 'annoteca-file-header-icon',
		});
		setIcon(fileIcon, 'file-text');

		header.createSpan({ cls: 'annoteca-file-header-name', text: basename });
		header.createSpan({
			cls: 'annoteca-file-header-path',
			text: group.path,
		});
		header.createSpan({
			cls: 'annoteca-file-header-count',
			text: countText,
		});

		header.addEventListener('click', () => {
			if (this.collapsedFilePaths.has(group.path)) {
				this.collapsedFilePaths.delete(group.path);
			} else {
				this.collapsedFilePaths.add(group.path);
			}
			this.refresh();
		});
	}

	private renderScopeToolbar(container: HTMLElement): void {
		const state = this.plugin.getScopeState();
		const active = this.app.workspace.getActiveFile();
		const dynamic = this.plugin.getDynamicScopeOptionsForActiveFile();

		const toolbar = container.createDiv({ cls: 'annoteca-scope-toolbar' });

		// Scope dropdown — populated dynamically from active file's metadata.
		interface ScopeOption {
			value: string;
			label: string;
			setter: () => Promise<void>;
		}
		const opts: ScopeOption[] = [];
		opts.push({
			value: 'file',
			label: 'This file',
			setter: () =>
				active
					? this.plugin.setScopeShape({ kind: 'file' }, active.path)
					: Promise.resolve(),
		});
		if (active && active.parent) {
			const folderPath = active.parent.path;
			const folderName = active.parent.name || 'vault root';
			opts.push({
				value: `folder:${folderPath}`,
				label: `This folder (${folderName})`,
				setter: () =>
					this.plugin.setScopeShape(
						{ kind: 'folder', subfolders: false },
						folderPath,
					),
			});
			opts.push({
				value: `folder-sub:${folderPath}`,
				label: `This folder + subfolders`,
				setter: () =>
					this.plugin.setScopeShape(
						{ kind: 'folder', subfolders: true },
						folderPath,
					),
			});
		}
		opts.push({
			value: 'vault',
			label: 'Vault',
			setter: () => this.plugin.setScopeShape({ kind: 'vault' }, ''),
		});
		for (const prop of dynamic.properties) {
			opts.push({
				value: `prop:${prop.key}::${prop.value}`,
				label: `Property: ${prop.key} = ${prop.value}`,
				setter: () =>
					this.plugin.setScopeShape(
						{ kind: 'property', key: prop.key, value: prop.value },
						'',
					),
			});
		}
		for (const tag of dynamic.tags) {
			opts.push({
				value: `tag:${tag}`,
				label: `Tag: ${tag}`,
				setter: () =>
					this.plugin.setScopeShape({ kind: 'tag', tag }, ''),
			});
		}

		const currentValue = this.currentScopeOptionValue(state);
		const scopeSelect = toolbar.createEl('select', {
			cls: 'annoteca-scope-select dropdown',
		});
		for (const o of opts) {
			const opt = scopeSelect.createEl('option', {
				value: o.value,
				text: o.label,
			});
			if (o.value === currentValue) opt.selected = true;
		}
		scopeSelect.addEventListener('change', () => {
			const v = scopeSelect.value;
			const target = opts.find((o) => o.value === v);
			if (target) void target.setter();
		});

		// Status filter dropdown.
		const statusSelect = toolbar.createEl('select', {
			cls: 'annoteca-scope-status dropdown',
		});
		for (const s of ['open', 'resolved', 'all'] as const) {
			const opt = statusSelect.createEl('option', {
				value: s,
				text: s.charAt(0).toUpperCase() + s.slice(1),
			});
			if (this.plugin.settings.statusFilter === s) opt.selected = true;
		}
		statusSelect.addEventListener('change', () => {
			void this.plugin.setStatusFilter(
				statusSelect.value as StatusFilter,
			);
		});

		// Pin button — when active, scope no longer auto-collapses on file change.
		const pinBtn = toolbar.createEl('button', {
			cls: `annoteca-scope-pin${state.pinned ? ' is-pinned' : ''}`,
		});
		setIcon(pinBtn, state.pinned ? 'pin' : 'pin-off');
		pinBtn.setAttribute(
			'aria-label',
			state.pinned
				? 'Unpin scope (allow auto-follow)'
				: 'Pin scope (do not follow file changes)',
		);
		pinBtn.addEventListener('click', () => {
			void this.plugin.togglePinScope();
		});
	}

	private currentScopeOptionValue(state: ScopeState): string {
		switch (state.shape.kind) {
			case 'file':
				return 'file';
			case 'folder':
				return state.shape.subfolders
					? `folder-sub:${state.anchorPath}`
					: `folder:${state.anchorPath}`;
			case 'vault':
				return 'vault';
			case 'property':
				return `prop:${state.shape.key}::${state.shape.value}`;
			case 'tag':
				return `tag:${state.shape.tag}`;
		}
	}

	private renderCommentCard(
		card: HTMLElement,
		c: Comment,
		path: string,
		isActive: boolean,
	): void {
		if (isActive) this.activeCardEl = card;
		const expanded = this.isCardExpanded(path, c.marker.start, isActive);
		const compact = this.renderCompactRow(card, c, path, expanded);

		// Card-body click selects the card and navigates the editor to the marker
		// (Option 2). Same-file just scrolls; cross-file opens the file then
		// scrolls. The chevron, sync, and star buttons stopPropagation so they do
		// not also trigger this navigation.
		compact.addEventListener('click', () => {
			this.activePath = path;
			this.activeStart = c.marker.start;
			// Ensure the file group is expanded so the newly-active card is visible.
			this.collapsedFilePaths.delete(path);
			this.refresh();
			void this.plugin.navigateToOffset(path, c.marker.start);
		});

		if (expanded) this.renderExpandedSection(card, c, path);
	}

	private renderCompactRow(
		card: HTMLElement,
		c: Comment,
		path: string,
		expanded: boolean,
	): HTMLElement {
		const enabled = resolveSettingsCategories(this.plugin.settings);
		const def = getCategoryOrFallback(c.category, enabled);

		const compact = card.createDiv({ cls: 'annoteca-reviewer-compact' });

		// Chevron toggles this card's expand state independent of selection (F-290),
		// so a reader on a small screen can collapse a tall active card or keep
		// several cards open at once.
		const chevron = compact.createEl('button', {
			cls: 'annoteca-reviewer-chevron',
			attr: {
				'aria-label': expanded ? 'Collapse comment' : 'Expand comment',
			},
		});
		setIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');
		chevron.addEventListener('click', (e) => {
			e.stopPropagation();
			this.cardExpandOverrides.set(
				this.cardKey(path, c.marker.start),
				!expanded,
			);
			this.refresh();
		});

		renderCategoryBadge(compact, def, {
			badge: 'annoteca-reviewer-category',
			icon: 'annoteca-reviewer-category-icon',
		});
		if (c.resolution)
			compact.createSpan({
				cls: 'annoteca-reviewer-state',
				text: 'resolved',
			});
		// F-270. Until now the panel never rendered addressed state at all, so a
		// comment awaiting accept/revise/reject was indistinguishable from an
		// untouched one unless you hovered its marker. Mirrors the hover popup's
		// precedence: a resolved comment is resolved, whatever came before.
		else if (c.addressed)
			compact.createSpan({
				cls: 'annoteca-reviewer-state annoteca-reviewer-state-addressed',
				text: 'addressed',
			});
		if (c.date)
			compact.createSpan({
				cls: 'annoteca-reviewer-meta',
				text: formatStamp(c.date),
			});
		if (c.author) {
			const authorEl = compact.createSpan({
				cls: 'annoteca-reviewer-meta',
				text: c.author,
			});
			this.applyAuthorColor(authorEl, c.author);
		}

		// Sync button (F-291): re-anchor the document to this marker, always, even
		// when it is already on screen. Forces the scroll past the don't-yank
		// short-circuit so the user can pull the document back to the annotation.
		const syncBtn = compact.createEl('button', {
			cls: 'annoteca-reviewer-sync',
			attr: { 'aria-label': 'Scroll document to this comment' },
		});
		setIcon(syncBtn, 'refresh-cw');
		syncBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.activePath = path;
			this.activeStart = c.marker.start;
			this.refresh();
			void this.plugin.navigateToOffset(path, c.marker.start, true);
		});

		// Star toggle at the right of the compact row. The panel re-renders on the
		// starred-changed event, so no in-place reflect is needed here.
		const hasId = Boolean(c.id);
		renderStarButton(compact, {
			cls: 'annoteca-row-star',
			hasId,
			starred: hasId && this.plugin.isStarred(c),
			onToggle: () => {
				void this.plugin.toggleStarred(c);
			},
		});

		compact.createDiv({
			cls: 'annoteca-reviewer-excerpt',
			text: truncate(c.body, 100),
		});
		if (c.replies.length > 0) {
			compact.createSpan({
				cls: 'annoteca-reviewer-replies-badge',
				text: replyCountLabel(c.replies.length),
			});
		}

		return compact;
	}

	private renderExpandedSection(
		card: HTMLElement,
		c: Comment,
		path: string,
	): void {
		const expandedSection = card.createDiv({
			cls: 'annoteca-reviewer-expanded',
		});
		const host = this.markdownHost(path);
		renderCommentMarkdown(
			expandedSection.createDiv({ cls: 'annoteca-reviewer-body' }),
			c.body,
			host,
		);

		if (c.resolution) {
			const res = expandedSection.createDiv({
				cls: 'annoteca-reviewer-resolution',
			});
			res.createSpan({
				text: `Resolved ${formatStamp(c.resolution.date)} by ${c.resolution.author}`,
			});
			if (c.resolution.note) {
				renderCommentMarkdown(
					res.createDiv({
						cls: 'annoteca-reviewer-resolution-note',
					}),
					c.resolution.note,
					host,
				);
			}
		}

		// F-270/F-271. The addressed note and, when the edit stored one, the
		// verbatim pre-edit prose. The original is what makes Reject meaningful,
		// so it has to be readable before deciding, not only from the hover popup.
		if (c.addressed) {
			const addr = expandedSection.createDiv({
				cls: 'annoteca-reviewer-addressed',
			});
			addr.createSpan({
				text: `Addressed ${formatStamp(c.addressed.date)} by ${c.addressed.author}`,
			});
			if (c.addressed.note) {
				renderCommentMarkdown(
					addr.createDiv({
						cls: 'annoteca-reviewer-addressed-note',
					}),
					c.addressed.note,
					host,
				);
			}
			if (c.addressed.original !== undefined) {
				addr.createDiv({
					cls: 'annoteca-reviewer-addressed-original-label',
					text: 'Original text',
				});
				// Plain text on purpose, matching the popover: this is the
				// verbatim prose Reject would restore, so it must be shown as
				// what would be written back, not as what it renders to.
				addr.createDiv({
					cls: 'annoteca-reviewer-addressed-original',
					text: c.addressed.original,
				});
			}
		}

		if (c.replies.length > 0) {
			const thread = expandedSection.createDiv({
				cls: 'annoteca-reviewer-thread',
			});
			thread.createEl('h5', { text: 'Replies' });
			for (const r of c.replies) {
				renderReplyRow(
					thread,
					r,
					THREAD_REPLY_CLASSES,
					(el, tag) => this.applyAuthorColor(el, tag),
					host,
				);
			}
		}

		this.renderReplyInput(expandedSection, c);
		this.renderActions(expandedSection, c, path);
	}

	private renderReplyInput(container: HTMLElement, c: Comment): void {
		const wrap = container.createDiv({ cls: 'annoteca-reply-input-wrap' });
		const textarea = wrap.createEl('textarea', {
			cls: 'annoteca-reply-input',
			attr: { placeholder: 'Reply…', rows: '3' },
		});
		// Restore any draft saved for this comment, mirroring the popup composer.
		if (c.id) {
			const draft = this.plugin.loadDraft(c.id);
			if (draft.length > 0) textarea.value = draft;
		}
		let saveTimer: number | undefined;
		textarea.addEventListener('input', () => {
			if (!c.id) return;
			if (saveTimer !== undefined) window.clearTimeout(saveTimer);
			saveTimer = window.setTimeout(() => {
				if (c.id) this.plugin.saveDraft(c.id, textarea.value);
				saveTimer = undefined;
			}, 300);
		});

		// F-274: per-reply author picker. Default plus configured collaborators
		// plus authors already in this thread.
		const controls = wrap.createDiv({ cls: 'annoteca-reply-controls' });
		const defaultAuthor =
			this.plugin.settings.authorTag !== ''
				? this.plugin.settings.authorTag
				: 'user';
		const threadAuthors = [
			c.author,
			...c.replies.map((r) => r.author),
		].filter((a): a is string => typeof a === 'string' && a.trim() !== '');
		const options = authorPickerOptions(
			defaultAuthor,
			this.plugin.settings.authorStyles,
			threadAuthors,
		);
		const authorSelect = controls.createEl('select', {
			cls: 'annoteca-reply-author-select dropdown',
		});
		for (const tag of options)
			authorSelect.createEl('option', { value: tag, text: tag });
		authorSelect.value = defaultAuthor;

		const submitBtn = controls.createEl('button', {
			cls: 'annoteca-reply-submit',
			text: 'Reply',
		});
		// Single-flight, matching the popover composer. The write is asynchronous
		// and can be refused, so without this a second press starts a second
		// append against the same snapshot and posts the reply twice.
		let pending = false;
		submitBtn.addEventListener('click', () => {
			if (pending) return;
			const body = textarea.value.trim();
			if (body === '') {
				new Notice('Reply is empty.');
				return;
			}
			const author = authorSelect.value.trim() || defaultAuthor;
			pending = true;
			submitBtn.disabled = true;
			textarea.readOnly = true;
			const release = (): void => {
				pending = false;
				submitBtn.disabled = false;
				textarea.readOnly = false;
			};
			void this.plugin
				.appendReply(c, { author, date: nowISO(), body })
				.then((wrote) => {
					// Keep what the user typed when the write was refused. The
					// draft is the only copy of it at that point.
					if (!wrote) {
						release();
						return;
					}
					textarea.value = '';
					if (c.id) this.plugin.clearDraft(c.id);
					release();
				})
				.catch(() => {
					// A vault read or write can reject on an adapter or transient
					// I/O error. Without this the button stays disabled with the
					// user's text trapped behind it, and the rejection surfaces as
					// an unhandled promise.
					release();
					new Notice('Could not save the reply. Try again.');
				});
		});
	}

	// F-275: tint an author label with its configured color via the CSS variable
	// the .annoteca-author rule consumes. No-op when the author has no style.
	private applyAuthorColor(el: HTMLElement, tag: string): void {
		const color = authorColorFor(tag, this.plugin.settings.authorStyles);
		if (!color) return;
		el.addClass('annoteca-author');
		el.style.setProperty('--annoteca-author-color', color);
	}

	private renderActions(
		container: HTMLElement,
		c: Comment,
		path: string,
	): void {
		const actions = container.createDiv({
			cls: 'annoteca-reviewer-actions',
		});

		if (c.resolution) {
			this.createActionButton(actions, 'Reopen', 'rotate-ccw', () => {
				void this.plugin.reopenComment(path, c);
			});
		} else if (c.addressed) {
			// F-270: an addressed comment gets accept / revise / reject in place
			// of the plain resolve actions, matching the hover popup exactly.
			// Accept resolves it, revise reopens it, reject reverts the prose.
			// These existed only behind hover before, which left the whole loop
			// unreachable on touch and invisible to anyone working panel-first.
			this.createActionButton(actions, 'Accept', 'check', () => {
				void this.plugin.acceptAddressedFromPanel(path, c);
			});
			this.createActionButton(actions, 'Revise', 'rotate-ccw', () => {
				void this.plugin.reviseAddressedFromPanel(path, c);
			});
			this.createActionButton(actions, 'Reject', 'undo-2', () => {
				void this.plugin.rejectAddressedFromPanel(path, c);
			});
		} else {
			this.createActionButton(actions, 'Resolve', 'check', () => {
				void this.plugin.resolveComment(path, c);
			});
			this.createActionButton(
				actions,
				'Resolve and remove',
				'check-check',
				() => {
					void this.plugin.resolveAndRemoveComment(path, c);
				},
			);
		}
		this.createActionButton(actions, 'Edit', 'pencil', () => {
			void this.plugin.editCommentFromReviewer(path, c);
		});
		this.createActionButton(actions, 'Delete', 'trash', () => {
			void this.plugin.deleteComment(path, c);
		});
		this.createActionButton(actions, 'Copy ID', 'copy', () => {
			void this.plugin.copyCommentId(c);
		});
		this.createActionButton(actions, 'Open', 'external-link', () => {
			void this.plugin.navigateToComment(path, c.marker.start, c);
		});
	}

	private createActionButton(
		parent: HTMLElement,
		label: string,
		icon: string,
		handler: () => void,
	): void {
		const btn = parent.createEl('button', { cls: 'annoteca-action-btn' });
		setIcon(btn, icon);
		btn.createSpan({ text: label });
		btn.addEventListener('click', handler);
	}

	private renderEmpty(container: HTMLElement, message: string): void {
		container.createEl('p', { text: message, cls: 'annoteca-empty' });
	}
}
