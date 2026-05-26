import {
	ItemView,
	WorkspaceLeaf,
	TFile,
	MarkdownView,
	Notice,
	setIcon,
} from "obsidian";

import type AnnotecaPlugin from "./main";
import type { Comment, LocatedComment, CategoryDefinition, ScopeState, StatusFilter } from "./types";
import { getCategoryOrFallback } from "./categories";
import { resolveSettingsCategories } from "./settings";
import { serialize, todayISO } from "./parser";
import { extractIndexTerm, bucketCommentsByHeading, type HeadingShape, type HeadingBucket } from "./view-utils";

export { extractIndexTerm, bucketCommentsByHeading };
export type { HeadingShape, HeadingBucket };

export const VAULT_UNRESOLVED_VIEW_TYPE = "annoteca-vault-unresolved-view";
export const INDEX_VIEW_TYPE = "annoteca-index-view";
export const COMPOSER_PANEL_VIEW_TYPE = "annoteca-composer-panel-view";
export const ANNOTECA_HUB_VIEW_TYPE = "annoteca-hub-view";

export type HubTab = "thread" | "outline" | "starred";


// Vault-wide unresolved view (F-051, F-052, F-053, F-056) -----------------------

interface VaultFilters {
	pathQuery: string;
	categories: Set<string>;
	state: "open" | "resolved" | "all";
}

export class VaultUnresolvedView extends ItemView {
	private readonly plugin: AnnotecaPlugin;
	private filters: VaultFilters = {
		pathQuery: "",
		categories: new Set(),
		state: "open",
	};

	constructor(leaf: WorkspaceLeaf, plugin: AnnotecaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VAULT_UNRESOLVED_VIEW_TYPE; }
	getDisplayText(): string { return "Annoteca: Unresolved"; }
	getIcon(): string { return "list-checks"; }

	async onOpen(): Promise<void> {
		await this.plugin.scanVaultIfNeeded();
		this.refresh();
		this.registerEvent(
			this.plugin.events.on("index-changed", () => this.refresh()),
		);
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private refresh(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("annoteca-view-root");

		container.createEl("h4", { text: "Vault comments" });

		const toolbar = container.createDiv({ cls: "annoteca-toolbar" });
		this.renderToolbar(toolbar);

		const results = this.plugin.commentIndex.queryUnresolved({
			resolved: this.filters.state,
			categories: this.filters.categories.size > 0 ? this.filters.categories : undefined,
		});

		const filtered = this.filters.pathQuery
			? results.filter(r => r.path.toLowerCase().includes(this.filters.pathQuery.toLowerCase()))
			: results;

		if (filtered.length === 0) {
			container.createEl("p", { text: "No comments match these filters.", cls: "annoteca-empty" });
			return;
		}

		const enabled = resolveSettingsCategories(this.plugin.settings);
		for (const r of filtered) {
			this.renderRow(container, r, enabled);
		}
	}

	private renderToolbar(toolbar: HTMLElement): void {
		const pathInput = toolbar.createEl("input", {
			cls: "annoteca-filter-path",
			attr: { type: "text", placeholder: "Filter by path…" },
		});
		pathInput.value = this.filters.pathQuery;
		pathInput.addEventListener("input", () => {
			this.filters.pathQuery = pathInput.value;
			this.refresh();
		});

		const stateSelect = toolbar.createEl("select", { cls: "annoteca-filter-state" });
		const options: Array<[VaultFilters["state"], string]> = [
			["open", "Open"],
			["resolved", "Resolved"],
			["all", "All"],
		];
		for (const [v, label] of options) {
			const opt = stateSelect.createEl("option", { text: label });
			opt.value = v;
			if (this.filters.state === v) opt.selected = true;
		}
		stateSelect.addEventListener("change", () => {
			this.filters.state = stateSelect.value as VaultFilters["state"];
			this.refresh();
		});

		const catFilters = toolbar.createDiv({ cls: "annoteca-filter-categories" });
		const enabled = resolveSettingsCategories(this.plugin.settings);
		for (const c of enabled) {
			const label = catFilters.createEl("label", { cls: "annoteca-filter-cat-label" });
			const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
			checkbox.checked = this.filters.categories.has(c.id);
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) this.filters.categories.add(c.id);
				else this.filters.categories.delete(c.id);
				this.refresh();
			});
			label.createSpan({ text: c.displayName });
		}
	}

	private renderRow(
		container: HTMLElement,
		located: LocatedComment,
		enabled: CategoryDefinition[],
	): void {
		const row = container.createDiv({ cls: "annoteca-vault-row" });
		if (located.comment.resolution) row.addClass("annoteca-row-resolved");

		const def = getCategoryOrFallback(located.comment.category, enabled);
		row.createSpan({
			cls: `annoteca-row-category annoteca-cat-${def.id}`,
			text: def.displayName,
		});

		row.createSpan({ cls: "annoteca-row-path", text: located.path });

		const body = located.comment.body.length > 120
			? located.comment.body.slice(0, 120) + "…"
			: located.comment.body;
		row.createSpan({ cls: "annoteca-row-body", text: body });

		row.addEventListener("click", () => {
			void this.plugin.navigateToComment(located.path, located.comment.marker.start, located.comment);
		});
	}
}

// Index entry view (F-260) -----------------------------------------------------

export class IndexEntryView extends ItemView {
	private readonly plugin: AnnotecaPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: AnnotecaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return INDEX_VIEW_TYPE; }
	getDisplayText(): string { return "Annoteca: Index entries"; }
	getIcon(): string { return "list"; }

	async onOpen(): Promise<void> {
		await this.plugin.scanVaultIfNeeded();
		this.refresh();
		this.registerEvent(this.plugin.events.on("index-changed", () => this.refresh()));
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private refresh(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("annoteca-view-root");
		container.createEl("h4", { text: "Index entries" });

		const entries = this.plugin.commentIndex.queryUnresolved({
			resolved: "all",
			categories: new Set(["index-entry"]),
		});
		if (entries.length === 0) {
			container.createEl("p", {
				text: "No index entries in this vault yet. Tag concepts with the index-entry category to populate this view.",
				cls: "annoteca-empty",
			});
			return;
		}

		const byTerm = new Map<string, typeof entries>();
		for (const e of entries) {
			const term = extractIndexTerm(e.comment.body);
			const bucket = byTerm.get(term) ?? [];
			bucket.push(e);
			byTerm.set(term, bucket);
		}

		const sortedTerms = Array.from(byTerm.keys()).sort();
		for (const term of sortedTerms) {
			const bucket = byTerm.get(term);
			if (!bucket) continue;
			const section = container.createDiv({ cls: "annoteca-index-section" });
			section.createEl("h5", { text: term });
			for (const located of bucket) {
				const row = section.createDiv({ cls: "annoteca-vault-row" });
				row.createSpan({ cls: "annoteca-row-path", text: located.path });
				row.createSpan({
					cls: "annoteca-row-body",
					text: located.comment.body,
				});
				row.addEventListener("click", () => {
					void this.plugin.navigateToComment(located.path, located.comment.marker.start, located.comment);
				});
			}
		}
	}
}

// Composer side-panel view (alternate to the modal) -----------------------------

import { ComposerForm, type ComposerRequest } from "./composer";

export class ComposerPanelView extends ItemView {
	private readonly plugin: AnnotecaPlugin;
	private pendingRequest: ComposerRequest | undefined;

	constructor(leaf: WorkspaceLeaf, plugin: AnnotecaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return COMPOSER_PANEL_VIEW_TYPE; }
	getDisplayText(): string { return "Compose comment"; }
	getIcon(): string { return "message-square-plus"; }

	setRequest(request: ComposerRequest): void {
		this.pendingRequest = request;
		this.refresh();
	}

	async onOpen(): Promise<void> {
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private refresh(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("annoteca-view-root");

		if (!this.pendingRequest) {
			container.createEl("p", {
				text: "Trigger the add-comment command from the editor to start a new comment here.",
				cls: "annoteca-empty",
			});
			return;
		}

		const form = new ComposerForm(this.plugin, this.pendingRequest, {
			close: () => {
				this.pendingRequest = undefined;
				this.refresh();
			},
			onSubmitted: (filePath, markerStart) => {
				void this.plugin.notifyComposerSubmitted(filePath, markerStart);
			},
		});
		form.render(container);
	}
}

export function serializeReplyAppended(c: Comment, reply: { author: string; date: string; body: string }): string {
	return serialize({
		id: c.id,
		category: c.category,
		body: c.body,
		date: c.date,
		author: c.author,
		replies: [...c.replies, reply],
		resolution: c.resolution,
	});
}

// Annoteca hub panel ---------------------------------------------------------
//
// The hub is the plugin's single right-sidebar surface. Replaces three earlier
// separate panels (per-file, reviewer, outline) with an internal tab strip
// that keeps the sidebar tab bar uncluttered. A fourth tab (starred) collects
// the user's bookmarked comments across the vault.

export class AnnotecaPanelView extends ItemView {
	private readonly plugin: AnnotecaPlugin;
	private activeTab: HubTab = "thread";
	private activePath: string | undefined;
	private activeStart: number | undefined;
	// Per-session collapse state for file groups in multi-file Thread scopes.
	// Reset when the active file changes and autoCollapseInactiveFiles is on.
	private collapsedFilePaths = new Set<string>();
	private lastActiveFileForCollapse: string | undefined;

	constructor(leaf: WorkspaceLeaf, plugin: AnnotecaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return ANNOTECA_HUB_VIEW_TYPE; }
	getDisplayText(): string { return "Annoteca"; }
	getIcon(): string { return "message-square"; }

	async onOpen(): Promise<void> {
		this.activeTab = this.plugin.settings.lastHubTab;
		const file = this.app.workspace.getActiveFile();
		this.activePath = file?.path;
		this.refresh();
		// Scan the vault once so that wider scopes (folder, vault, property,
		// tag) have populated comment data. The first refresh above shows the
		// current file only; when the scan completes it emits "index-changed"
		// and the listener below triggers a second refresh with full data.
		void this.plugin.scanVaultIfNeeded();

		this.registerEvent(this.plugin.events.on("active-comment-changed", (payload) => {
			const event = payload as { path: string; start: number };
			this.activePath = event.path;
			this.activeStart = event.start;
			// Marker clicks force the Thread tab; the user's intent is to see
			// the comment they clicked, not whatever tab was last viewed.
			this.activeTab = "thread";
			void this.plugin.setLastHubTab("thread");
			this.refresh();
		}));

		this.registerEvent(this.plugin.events.on("index-changed", () => this.refresh()));
		this.registerEvent(this.plugin.events.on("starred-changed", () => {
			if (this.activeTab === "starred" || this.activeTab === "thread") this.refresh();
		}));
		this.registerEvent(this.plugin.events.on("scope-changed", () => {
			if (this.activeTab === "thread") this.refresh();
		}));

		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			const f = this.app.workspace.getActiveFile();
			if (!f) return;
			if (f.path === this.activePath) return;
			this.activePath = f.path;
			this.activeStart = undefined;
			this.refresh();
		}));
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private async setActiveTab(tab: HubTab): Promise<void> {
		if (this.activeTab === tab) return;
		this.activeTab = tab;
		await this.plugin.setLastHubTab(tab);
		this.refresh();
	}

	private refresh(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("annoteca-hub-root");

		this.renderTabStrip(container);

		const content = container.createDiv({ cls: "annoteca-hub-content" });
		switch (this.activeTab) {
			case "thread": this.renderThreadTab(content); break;
			case "outline": this.renderOutlineTab(content); break;
			case "starred": this.renderStarredTab(content); break;
		}
	}

	private renderTabStrip(container: HTMLElement): void {
		const strip = container.createDiv({ cls: "annoteca-hub-tabs" });
		const tabs: Array<{ id: HubTab; label: string }> = [
			{ id: "thread", label: "Thread" },
			{ id: "outline", label: "Outline" },
			{ id: "starred", label: "Starred" },
		];
		for (const t of tabs) {
			const btn = strip.createEl("button", {
				cls: `annoteca-hub-tab${this.activeTab === t.id ? " is-active" : ""}`,
				text: t.label,
			});
			btn.addEventListener("click", () => { void this.setActiveTab(t.id); });
		}
	}

	// ---- Thread tab (active comment + replies + composer + actions) ----

	private renderThreadTab(container: HTMLElement): void {
		this.renderScopeToolbar(container);

		const scopeFiles = this.plugin.computeScopeFiles();
		if (scopeFiles.size === 0) {
			this.renderEmpty(container, "No files in current scope.");
			return;
		}

		const statusFilter = this.plugin.settings.statusFilter;
		interface FileGroup { path: string; comments: Comment[]; }
		const groups: FileGroup[] = [];
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

		if (groups.length === 0) {
			this.renderEmpty(container, "No comments match this scope and filter.");
			return;
		}

		// Pick or validate the active comment. Identity is (path, start) — across
		// files a bare marker.start could collide. Default to the first comment in
		// the active file's group (if in scope), then fall back to the first group.
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

		const showGroups = groups.length > 1;

		// Apply auto-collapse policy when the active file has just changed.
		// We only reset the collapse set on active-file transitions so the
		// user's manual expand/collapse choices stick while they work in one
		// file.
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

		const list = container.createDiv({ cls: "annoteca-reviewer-list" });
		for (const group of groups) {
			if (showGroups) {
				const collapsed = this.collapsedFilePaths.has(group.path);
				const groupEl = list.createDiv({
					cls: `annoteca-file-group${collapsed ? " is-collapsed" : ""}`,
				});
				this.renderFileHeader(groupEl, group, collapsed);
				if (!collapsed) {
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

	// ---- Outline tab (density per heading) ----

	private renderOutlineTab(container: HTMLElement): void {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			this.renderEmpty(container, "No file open.");
			return;
		}
		container.createEl("h4", { text: file.basename });

		const cache = this.app.metadataCache.getFileCache(file);
		const headings = cache?.headings ?? [];
		const idx = this.plugin.commentIndex.get(file.path);
		const comments = idx?.comments ?? [];

		if (headings.length === 0) {
			container.createEl("p", {
				text: `No headings. ${comments.length} comment(s) total.`,
				cls: "annoteca-empty",
			});
			return;
		}

		// Bucket the comments by heading so each count badge can also surface
		// the actual comments it refers to (for click-to-first-comment).
		const commentsByBucket: Comment[][] = headings.map(() => []);
		for (const c of comments) {
			let idxBucket = -1;
			for (let i = 0; i < headings.length; i++) {
				const h = headings[i];
				if (!h) continue;
				if (h.position.start.offset > c.marker.start) break;
				idxBucket = i;
			}
			if (idxBucket >= 0) commentsByBucket[idxBucket]?.push(c);
		}

		// Determine which heading contains the editor's cursor so we can mark
		// that row as "current." Looks up the leaf showing this file directly
		// rather than getActiveViewOfType, which returns null when the hub
		// itself is the active leaf.
		const editorLeaf = this.app.workspace.getLeavesOfType("markdown")
			.find(l => (l.view as MarkdownView).file?.path === file.path);
		let cursorBucket = -1;
		if (editorLeaf) {
			const editor = (editorLeaf.view as MarkdownView).editor;
			const offset = editor.posToOffset(editor.getCursor());
			for (let i = 0; i < headings.length; i++) {
				const h = headings[i];
				if (!h) continue;
				if (h.position.start.offset > offset) break;
				cursorBucket = i;
			}
		}

		for (let i = 0; i < headings.length; i++) {
			const h = headings[i];
			if (!h) continue;
			const inBucket = commentsByBucket[i] ?? [];
			const openList = inBucket.filter(c => !c.resolution);
			const resolvedList = inBucket.filter(c => c.resolution !== undefined);
			const row = container.createDiv({
				cls: `annoteca-density-row${cursorBucket === i ? " is-current" : ""}`,
				attr: { "data-level": String(h.level) },
			});
			row.createSpan({ cls: "annoteca-density-heading", text: h.heading });
			const counts = row.createSpan({ cls: "annoteca-density-counts" });

			if (openList.length > 0) {
				const openBadge = counts.createEl("button", {
					cls: "annoteca-density-open clickable",
					text: `${openList.length} open`,
				});
				openBadge.addEventListener("click", e => {
					e.stopPropagation();
					const first = openList[0];
					if (first) void this.plugin.navigateToComment(file.path, first.marker.start, first);
				});
			}
			if (resolvedList.length > 0) {
				const resolvedBadge = counts.createEl("button", {
					cls: "annoteca-density-resolved clickable",
					text: `${resolvedList.length} resolved`,
				});
				resolvedBadge.addEventListener("click", e => {
					e.stopPropagation();
					const first = resolvedList[0];
					if (first) void this.plugin.navigateToComment(file.path, first.marker.start, first);
				});
			}
			row.addEventListener("click", () => {
				void this.plugin.navigateToOffset(file.path, h.position.start.offset);
			});
		}
	}

	// ---- Starred tab (cross-file list) ----

	private renderStarredTab(container: HTMLElement): void {
		const ids = new Set(this.plugin.settings.starredComments);
		if (ids.size === 0) {
			this.renderEmpty(container, "No starred comments yet. Hover a comment marker and click the star to add one.");
			return;
		}

		// Walk the entire index and collect every comment whose id is starred.
		// Preserve user's star order (most recently starred first) by indexing
		// by id and walking the starredComments array in reverse.
		const byId = new Map<string, { path: string; comment: Comment }>();
		for (const idx of this.plugin.commentIndex.all()) {
			for (const c of idx.comments) {
				if (c.id && ids.has(c.id)) {
					byId.set(c.id, { path: idx.path, comment: c });
				}
			}
		}

		const ordered: Array<{ path: string; comment: Comment }> = [];
		for (let i = this.plugin.settings.starredComments.length - 1; i >= 0; i--) {
			const id = this.plugin.settings.starredComments[i];
			if (!id) continue;
			const hit = byId.get(id);
			if (hit) ordered.push(hit);
		}

		if (ordered.length === 0) {
			this.renderEmpty(container, "All starred comments are missing from the vault. Use the cleanup command to clear orphans.");
			return;
		}

		const enabled = resolveSettingsCategories(this.plugin.settings);
		const list = container.createDiv({ cls: "annoteca-starred-list" });
		for (const entry of ordered) {
			const c = entry.comment;
			const def = getCategoryOrFallback(c.category, enabled);
			const card = list.createDiv({ cls: "annoteca-starred-card" });

			const head = card.createDiv({ cls: "annoteca-starred-head" });
			const catBadge = head.createSpan({
				cls: `annoteca-reviewer-category annoteca-cat-${def.id}`,
			});
			if (def.icon) {
				const iconEl = catBadge.createSpan({ cls: "annoteca-reviewer-category-icon" });
				setIcon(iconEl, def.icon);
			}
			catBadge.createSpan({ text: def.displayName });

			const starBtn = head.createEl("button", {
				cls: "annoteca-row-star is-starred",
				text: "★",
			});
			starBtn.setAttribute("aria-label", "Unstar");
			starBtn.addEventListener("click", e => {
				e.stopPropagation();
				void this.plugin.toggleStarred(c);
			});

			const fileLine = card.createDiv({ cls: "annoteca-starred-file" });
			fileLine.createSpan({ text: entry.path });

			const body = c.body.length > 160 ? c.body.slice(0, 160) + "…" : c.body;
			card.createDiv({ cls: "annoteca-starred-body", text: body });

			if (c.date || c.author || c.resolution) {
				const meta = card.createDiv({ cls: "annoteca-starred-meta" });
				if (c.resolution) meta.createSpan({ cls: "annoteca-reviewer-state", text: "resolved" });
				if (c.date) meta.createSpan({ text: c.date });
				if (c.author) meta.createSpan({ text: c.author });
			}

			card.addEventListener("click", () => {
				void this.plugin.navigateToComment(entry.path, c.marker.start, c);
			});
		}
	}

	private renderEmpty(container: HTMLElement, message: string): void {
		container.createEl("p", { text: message, cls: "annoteca-empty" });
	}
}
