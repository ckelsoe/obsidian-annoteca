// Thread tab renderer for the Annoteca hub. Owns the scope toolbar,
// active-comment selection, per-session collapse state, file-group
// rendering, and the comment card (compact + expanded) inside the
// Thread tab. Public mutable fields `activePath` / `activeStart` are
// updated by the parent view's event handlers; the parent calls
// `render()` after writing them.

import { Notice, TFile, setIcon, type App } from "obsidian";

import type AnnotecaPlugin from "./main";
import type { Comment, ScopeState, StatusFilter } from "./types";
import { getCategoryOrFallback } from "./categories";
import { resolveSettingsCategories } from "./settings";
import { todayISO } from "./parser";

export class ThreadTabRenderer {
	activePath: string | undefined;
	activeStart: number | undefined;
	// Per-session collapse state for file groups in multi-file Thread scopes.
	// Reset when the active file changes and autoCollapseInactiveFiles is on.
	private collapsedFilePaths = new Set<string>();
	private lastActiveFileForCollapse: string | undefined;

	constructor(
		private readonly plugin: AnnotecaPlugin,
		private readonly app: App,
		private readonly refresh: () => void,
	) {}

	render(container: HTMLElement): void {
		this.renderScopeToolbar(container);

		const scopeFiles = this.plugin.computeScopeFiles();
		if (scopeFiles.size === 0) {
			this.renderEmpty(container, "No files in current scope.");
			return;
		}

		const groups = this.buildScopedGroups(scopeFiles);
		if (groups.length === 0) {
			this.renderEmpty(container, "No comments match this scope and filter.");
			return;
		}

		this.selectActiveComment(groups);

		const showGroups = groups.length > 1;
		this.applyAutoCollapsePolicy(groups, showGroups);

		const list = container.createDiv({ cls: "annoteca-reviewer-list" });
		for (const group of groups) {
			if (showGroups) {
				this.renderFileGroup(list, group);
			} else {
				// Single-file scope: cards directly in the list, no header.
				for (const c of group.comments) {
					const isActive = c.marker.start === this.activeStart;
					const card = list.createDiv({
						cls: `annoteca-reviewer-card${isActive ? " is-active" : ""}`,
					});
					this.renderCommentCard(card, c, group.path, isActive);
				}
			}
		}
	}

	private buildScopedGroups(scopeFiles: Set<string>): { path: string; comments: Comment[] }[] {
		const statusFilter = this.plugin.settings.statusFilter;
		const groups: { path: string; comments: Comment[] }[] = [];
		for (const p of [...scopeFiles].sort()) {
			const idx = this.plugin.commentIndex.get(p);
			if (!idx) continue;
			const filtered = idx.comments.filter(c => {
				if (statusFilter === "open") return !c.resolution;
				if (statusFilter === "resolved") return c.resolution !== undefined;
				return true;
			});
			if (filtered.length > 0) groups.push({ path: p, comments: filtered });
		}
		return groups;
	}

	// Pick or validate the active comment. Identity is (path, start) — across
	// files a bare marker.start could collide. Default to the first comment in
	// the active file's group (if in scope), then fall back to the first group.
	private selectActiveComment(groups: { path: string; comments: Comment[] }[]): void {
		const activeFilePath = this.app.workspace.getActiveFile()?.path;
		const activeGroup = activeFilePath ? groups.find(g => g.path === activeFilePath) : undefined;
		const stillValid = groups.some(
			g => g.path === this.activePath && g.comments.some(c => c.marker.start === this.activeStart),
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
		const activeFileForCollapse = this.activePath ?? this.app.workspace.getActiveFile()?.path;
		if (showGroups && this.plugin.settings.autoCollapseInactiveFiles
			&& activeFileForCollapse
			&& this.lastActiveFileForCollapse !== activeFileForCollapse) {
			this.collapsedFilePaths.clear();
			for (const g of groups) {
				if (g.path !== activeFileForCollapse) this.collapsedFilePaths.add(g.path);
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
			cls: `annoteca-file-group${collapsed ? " is-collapsed" : ""}`,
		});
		this.renderFileHeader(groupEl, group, collapsed);
		if (collapsed) return;
		const body = groupEl.createDiv({ cls: "annoteca-file-group-body" });
		for (const c of group.comments) {
			const isActive = group.path === this.activePath
				&& c.marker.start === this.activeStart;
			const card = body.createDiv({
				cls: `annoteca-reviewer-card${isActive ? " is-active" : ""}`,
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
		const open = group.comments.filter(c => !c.resolution).length;
		const total = group.comments.length;
		const countText = open === total ? `${total}` : `${open}/${total}`;

		const header = container.createDiv({ cls: "annoteca-file-header" });

		const chevron = header.createSpan({ cls: "annoteca-file-header-chevron" });
		setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");

		const fileIcon = header.createSpan({ cls: "annoteca-file-header-icon" });
		setIcon(fileIcon, "file-text");

		header.createSpan({ cls: "annoteca-file-header-name", text: basename });
		header.createSpan({ cls: "annoteca-file-header-path", text: group.path });
		header.createSpan({ cls: "annoteca-file-header-count", text: countText });

		header.addEventListener("click", () => {
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

		const toolbar = container.createDiv({ cls: "annoteca-scope-toolbar" });

		// Scope dropdown — populated dynamically from active file's metadata.
		interface ScopeOption { value: string; label: string; setter: () => Promise<void>; }
		const opts: ScopeOption[] = [];
		opts.push({
			value: "file",
			label: "This file",
			setter: () => active ? this.plugin.setScopeShape({ kind: "file" }, active.path) : Promise.resolve(),
		});
		if (active && active.parent) {
			const folderPath = active.parent.path;
			const folderName = active.parent.name || "vault root";
			opts.push({
				value: `folder:${folderPath}`,
				label: `This folder (${folderName})`,
				setter: () => this.plugin.setScopeShape({ kind: "folder", subfolders: false }, folderPath),
			});
			opts.push({
				value: `folder-sub:${folderPath}`,
				label: `This folder + subfolders`,
				setter: () => this.plugin.setScopeShape({ kind: "folder", subfolders: true }, folderPath),
			});
		}
		opts.push({
			value: "vault",
			label: "Vault",
			setter: () => this.plugin.setScopeShape({ kind: "vault" }, ""),
		});
		for (const prop of dynamic.properties) {
			opts.push({
				value: `prop:${prop.key}::${prop.value}`,
				label: `Property: ${prop.key} = ${prop.value}`,
				setter: () => this.plugin.setScopeShape(
					{ kind: "property", key: prop.key, value: prop.value },
					"",
				),
			});
		}
		for (const tag of dynamic.tags) {
			opts.push({
				value: `tag:${tag}`,
				label: `Tag: ${tag}`,
				setter: () => this.plugin.setScopeShape({ kind: "tag", tag }, ""),
			});
		}

		const currentValue = this.currentScopeOptionValue(state);
		const scopeSelect = toolbar.createEl("select", { cls: "annoteca-scope-select dropdown" });
		for (const o of opts) {
			const opt = scopeSelect.createEl("option", { value: o.value, text: o.label });
			if (o.value === currentValue) opt.selected = true;
		}
		scopeSelect.addEventListener("change", () => {
			const v = scopeSelect.value;
			const target = opts.find(o => o.value === v);
			if (target) void target.setter();
		});

		// Status filter dropdown.
		const statusSelect = toolbar.createEl("select", { cls: "annoteca-scope-status dropdown" });
		for (const s of ["open", "resolved", "all"] as const) {
			const opt = statusSelect.createEl("option", {
				value: s,
				text: s.charAt(0).toUpperCase() + s.slice(1),
			});
			if (this.plugin.settings.statusFilter === s) opt.selected = true;
		}
		statusSelect.addEventListener("change", () => {
			void this.plugin.setStatusFilter(statusSelect.value as StatusFilter);
		});

		// Pin button — when active, scope no longer auto-collapses on file change.
		const pinBtn = toolbar.createEl("button", {
			cls: `annoteca-scope-pin${state.pinned ? " is-pinned" : ""}`,
		});
		setIcon(pinBtn, state.pinned ? "pin" : "pin-off");
		pinBtn.setAttribute(
			"aria-label",
			state.pinned ? "Unpin scope (allow auto-follow)" : "Pin scope (do not follow file changes)",
		);
		pinBtn.addEventListener("click", () => { void this.plugin.togglePinScope(); });
	}

	private currentScopeOptionValue(state: ScopeState): string {
		switch (state.shape.kind) {
			case "file": return "file";
			case "folder":
				return state.shape.subfolders
					? `folder-sub:${state.anchorPath}`
					: `folder:${state.anchorPath}`;
			case "vault": return "vault";
			case "property": return `prop:${state.shape.key}::${state.shape.value}`;
			case "tag": return `tag:${state.shape.tag}`;
		}
	}

	private renderCommentCard(card: HTMLElement, c: Comment, path: string, expanded: boolean): void {
		const compact = this.renderCompactRow(card, c);

		if (!expanded) {
			compact.addEventListener("click", () => {
				this.activePath = path;
				this.activeStart = c.marker.start;
				// Ensure the file is expanded so the newly-active card is visible.
				this.collapsedFilePaths.delete(path);
				this.refresh();
				// Also navigate the editor to the marker. Same-file: just
				// scrolls. Cross-file: opens the file and scrolls. Cursor
				// at marker.start no longer triggers raw-text mode after the
				// selectionTouches fix.
				void this.plugin.navigateToOffset(path, c.marker.start);
			});
			return;
		}

		this.renderExpandedSection(card, c, path);
	}

	private renderCompactRow(card: HTMLElement, c: Comment): HTMLElement {
		const enabled = resolveSettingsCategories(this.plugin.settings);
		const def = getCategoryOrFallback(c.category, enabled);

		const compact = card.createDiv({ cls: "annoteca-reviewer-compact" });
		const catBadge = compact.createSpan({
			cls: `annoteca-reviewer-category annoteca-cat-${def.id}`,
		});
		if (def.icon) {
			const iconEl = catBadge.createSpan({ cls: "annoteca-reviewer-category-icon" });
			setIcon(iconEl, def.icon);
		}
		catBadge.createSpan({ text: def.displayName });
		if (c.resolution) compact.createSpan({ cls: "annoteca-reviewer-state", text: "resolved" });
		if (c.date) compact.createSpan({ cls: "annoteca-reviewer-meta", text: c.date });
		if (c.author) compact.createSpan({ cls: "annoteca-reviewer-meta", text: c.author });

		// Star toggle at the right of the compact row.
		const starBtn = compact.createEl("button", {
			cls: "annoteca-row-star",
			text: "★",
		});
		const hasId = Boolean(c.id);
		const starred = hasId && this.plugin.isStarred(c);
		if (starred) starBtn.addClass("is-starred");
		if (!hasId) starBtn.addClass("is-disabled");
		starBtn.setAttribute("aria-label", starred ? "Unstar" : "Star");
		starBtn.addEventListener("click", e => {
			e.stopPropagation();
			if (!hasId) return;
			void this.plugin.toggleStarred(c);
		});

		const excerpt = c.body.length > 100 ? c.body.slice(0, 100) + "…" : c.body;
		compact.createDiv({ cls: "annoteca-reviewer-excerpt", text: excerpt });
		if (c.replies.length > 0) {
			compact.createSpan({
				cls: "annoteca-reviewer-replies-badge",
				text: `${c.replies.length} repl${c.replies.length === 1 ? "y" : "ies"}`,
			});
		}

		return compact;
	}

	private renderExpandedSection(card: HTMLElement, c: Comment, path: string): void {
		const expandedSection = card.createDiv({ cls: "annoteca-reviewer-expanded" });
		expandedSection.createDiv({ cls: "annoteca-reviewer-body", text: c.body });

		if (c.resolution) {
			const res = expandedSection.createDiv({ cls: "annoteca-reviewer-resolution" });
			res.createSpan({ text: `Resolved ${c.resolution.date} by ${c.resolution.author}` });
			if (c.resolution.note) {
				res.createDiv({ cls: "annoteca-reviewer-resolution-note", text: c.resolution.note });
			}
		}

		if (c.replies.length > 0) {
			const thread = expandedSection.createDiv({ cls: "annoteca-reviewer-thread" });
			thread.createEl("h5", { text: "Replies" });
			for (const r of c.replies) {
				const item = thread.createDiv({ cls: "annoteca-reply" });
				const meta = item.createDiv({ cls: "annoteca-reply-meta" });
				meta.createSpan({ text: r.author });
				meta.createSpan({ text: r.date });
				item.createDiv({ cls: "annoteca-reply-body", text: r.body });
			}
		}

		this.renderReplyInput(expandedSection, c);
		this.renderActions(expandedSection, c, path);
	}

	private renderReplyInput(container: HTMLElement, c: Comment): void {
		const wrap = container.createDiv({ cls: "annoteca-reply-input-wrap" });
		const textarea = wrap.createEl("textarea", {
			cls: "annoteca-reply-input",
			attr: { placeholder: "Reply…", rows: "3" },
		});
		// Restore any draft saved for this comment, mirroring the popup composer.
		if (c.id) {
			const draft = this.plugin.loadDraft(c.id);
			if (draft.length > 0) textarea.value = draft;
		}
		let saveTimer: number | undefined;
		textarea.addEventListener("input", () => {
			if (!c.id) return;
			if (saveTimer !== undefined) window.clearTimeout(saveTimer);
			saveTimer = window.setTimeout(() => {
				if (c.id) this.plugin.saveDraft(c.id, textarea.value);
				saveTimer = undefined;
			}, 300);
		});

		const submitBtn = wrap.createEl("button", { cls: "annoteca-reply-submit", text: "Reply" });
		submitBtn.addEventListener("click", () => {
			const body = textarea.value.trim();
			if (body === "") {
				new Notice("Reply is empty.");
				return;
			}
			const author = this.plugin.settings.authorTag !== "" ? this.plugin.settings.authorTag : "user";
			void this.plugin.appendReply(c, { author, date: todayISO(), body }).then(() => {
				textarea.value = "";
				if (c.id) this.plugin.clearDraft(c.id);
			});
		});
	}

	private renderActions(container: HTMLElement, c: Comment, path: string): void {
		const actions = container.createDiv({ cls: "annoteca-reviewer-actions" });

		if (c.resolution) {
			this.createActionButton(actions, "Reopen", "rotate-ccw", () => {
				void this.plugin.reopenComment(path, c);
			});
		} else {
			this.createActionButton(actions, "Resolve", "check", () => {
				void this.plugin.resolveComment(path, c);
			});
		}
		this.createActionButton(actions, "Edit", "pencil", () => {
			void this.plugin.editCommentFromReviewer(path, c);
		});
		this.createActionButton(actions, "Delete", "trash", () => {
			void this.plugin.deleteComment(path, c);
		});
		this.createActionButton(actions, "Copy ID", "copy", () => {
			void this.plugin.copyCommentId(c);
		});
		this.createActionButton(actions, "Open", "external-link", () => {
			void this.plugin.navigateToComment(path, c.marker.start, c);
		});
	}

	private createActionButton(
		parent: HTMLElement,
		label: string,
		icon: string,
		handler: () => void,
	): void {
		const btn = parent.createEl("button", { cls: "annoteca-action-btn" });
		setIcon(btn, icon);
		btn.createSpan({ text: label });
		btn.addEventListener("click", handler);
	}

	private renderEmpty(container: HTMLElement, message: string): void {
		container.createEl("p", { text: message, cls: "annoteca-empty" });
	}
}
