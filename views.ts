import {
	ItemView,
	WorkspaceLeaf,
	type TFile,
	Notice,
	setIcon,
} from "obsidian";

import type AnnotecaPlugin from "./main";
import type { Comment, LocatedComment, CategoryDefinition } from "./types";
import { getCategoryOrFallback } from "./categories";
import { resolveSettingsCategories } from "./settings";
import { serialize, todayISO } from "./parser";

export const PER_FILE_VIEW_TYPE = "annoteca-per-file-view";
export const VAULT_UNRESOLVED_VIEW_TYPE = "annoteca-vault-unresolved-view";
export const REVIEWER_PANE_VIEW_TYPE = "annoteca-reviewer-pane-view";

// Per-file sidebar (F-046, F-047) ------------------------------------------------

export class PerFileSidebarView extends ItemView {
	private readonly plugin: AnnotecaPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: AnnotecaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return PER_FILE_VIEW_TYPE; }
	getDisplayText(): string { return "File comments"; }
	getIcon(): string { return "messages-square"; }

	async onOpen(): Promise<void> {
		this.refresh();
		this.registerEvent(
			this.plugin.events.on("index-changed", () => this.refresh()),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.refresh()),
		);
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private refresh(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("annoteca-view-root");

		const file = this.app.workspace.getActiveFile();
		if (!file) {
			container.createEl("p", { text: "No file open.", cls: "annoteca-empty" });
			return;
		}

		container.createEl("h4", { text: file.basename });

		const idx = this.plugin.commentIndex.get(file.path);
		const comments = idx?.comments ?? [];
		if (comments.length === 0) {
			container.createEl("p", {
				text: "No comments in this file.",
				cls: "annoteca-empty",
			});
			return;
		}

		const enabled = resolveSettingsCategories(this.plugin.settings);
		const groups = new Map<string, Comment[]>();
		for (const c of comments) {
			const list = groups.get(c.category) ?? [];
			list.push(c);
			groups.set(c.category, list);
		}

		const orderedCategoryIds = enabled.map(c => c.id);
		for (const cat of groups.keys()) {
			if (!orderedCategoryIds.includes(cat)) orderedCategoryIds.push(cat);
		}

		for (const cat of orderedCategoryIds) {
			const list = groups.get(cat);
			if (!list || list.length === 0) continue;
			const def = getCategoryOrFallback(cat, enabled);
			this.renderGroup(container, def, list, file);
		}
	}

	private renderGroup(
		container: HTMLElement,
		def: CategoryDefinition,
		comments: Comment[],
		file: TFile,
	): void {
		const section = container.createDiv({ cls: "annoteca-group" });
		const header = section.createDiv({ cls: "annoteca-group-header" });
		header.createSpan({
			cls: `annoteca-group-label annoteca-cat-${def.id}`,
			text: def.displayName,
		});
		header.createSpan({ cls: "annoteca-group-count", text: String(comments.length) });

		for (const c of comments) {
			const row = section.createDiv({ cls: "annoteca-row" });
			if (c.resolution) row.addClass("annoteca-row-resolved");
			const body = c.body.length > 100 ? c.body.slice(0, 100) + "…" : c.body;
			row.createDiv({ cls: "annoteca-row-body", text: body });
			if (c.date || c.author) {
				const meta = row.createDiv({ cls: "annoteca-row-meta" });
				if (c.date) meta.createSpan({ text: c.date });
				if (c.author) meta.createSpan({ text: `· ${c.author}` });
			}
			row.addEventListener("click", () => {
				void this.plugin.navigateToComment(file.path, c.marker.start, c);
			});
		}
	}
}

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
	getDisplayText(): string { return "Unresolved comments"; }
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

// Reviewer pane (F-049, F-050) --------------------------------------------------

export class ReviewerPaneView extends ItemView {
	private readonly plugin: AnnotecaPlugin;
	private activePath: string | undefined;
	private activeStart: number | undefined;
	private pinned = false;

	constructor(leaf: WorkspaceLeaf, plugin: AnnotecaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return REVIEWER_PANE_VIEW_TYPE; }
	getDisplayText(): string { return "Reviewer"; }
	getIcon(): string { return "message-square"; }

	async onOpen(): Promise<void> {
		this.renderEmpty();
		this.registerEvent(this.plugin.events.on("active-comment-changed", (payload) => {
			const event = payload as { path: string; start: number };
			if (this.pinned && this.activeStart !== undefined && event.start !== this.activeStart) {
				// When pinned, the pane keeps showing the active comment.
				return;
			}
			this.activePath = event.path;
			this.activeStart = event.start;
			this.refresh();
		}));
		this.registerEvent(this.plugin.events.on("index-changed", () => this.refresh()));
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	togglePinned(): boolean {
		this.pinned = !this.pinned;
		this.refresh();
		return this.pinned;
	}

	private renderEmpty(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("annoteca-view-root");
		container.createEl("p", {
			text: "Click a comment indicator to open it here.",
			cls: "annoteca-empty",
		});
	}

	private refresh(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("annoteca-view-root");

		if (this.activePath === undefined || this.activeStart === undefined) {
			this.renderEmpty();
			return;
		}

		const idx = this.plugin.commentIndex.get(this.activePath);
		if (!idx) {
			this.renderEmpty();
			return;
		}
		const comment = idx.comments.find(c => c.marker.start === this.activeStart);
		if (!comment) {
			this.renderEmpty();
			return;
		}

		this.renderHeader(container, comment);
		this.renderBody(container, comment);
		this.renderThread(container, comment);
		this.renderReplyInput(container, comment);
		this.renderActions(container, comment);
	}

	private renderHeader(container: HTMLElement, c: Comment): void {
		const enabled = resolveSettingsCategories(this.plugin.settings);
		const def = getCategoryOrFallback(c.category, enabled);

		const header = container.createDiv({ cls: "annoteca-reviewer-header" });
		header.createSpan({
			cls: `annoteca-reviewer-category annoteca-cat-${def.id}`,
			text: def.displayName,
		});
		if (c.date) header.createSpan({ cls: "annoteca-reviewer-meta", text: c.date });
		if (c.author) header.createSpan({ cls: "annoteca-reviewer-meta", text: c.author });
		if (c.id) header.createSpan({ cls: "annoteca-reviewer-meta", text: `id:${c.id}` });

		const pinBtn = header.createEl("button", { cls: "annoteca-reviewer-pin" });
		setIcon(pinBtn, this.pinned ? "pin" : "pin-off");
		pinBtn.addEventListener("click", () => this.togglePinned());

		header.createDiv({
			cls: "annoteca-reviewer-path",
			text: this.activePath ?? "",
		});
	}

	private renderBody(container: HTMLElement, c: Comment): void {
		const body = container.createDiv({ cls: "annoteca-reviewer-body" });
		body.setText(c.body);
		if (c.resolution) {
			const res = container.createDiv({ cls: "annoteca-reviewer-resolution" });
			res.createSpan({ text: `Resolved ${c.resolution.date} by ${c.resolution.author}` });
			if (c.resolution.note) {
				res.createDiv({ cls: "annoteca-reviewer-resolution-note", text: c.resolution.note });
			}
		}
	}

	private renderThread(container: HTMLElement, c: Comment): void {
		if (c.replies.length === 0) return;
		const thread = container.createDiv({ cls: "annoteca-reviewer-thread" });
		thread.createEl("h5", { text: "Replies" });
		for (const r of c.replies) {
			const item = thread.createDiv({ cls: "annoteca-reply" });
			const meta = item.createDiv({ cls: "annoteca-reply-meta" });
			meta.createSpan({ text: r.author });
			meta.createSpan({ text: r.date });
			item.createDiv({ cls: "annoteca-reply-body", text: r.body });
		}
	}

	private renderReplyInput(container: HTMLElement, c: Comment): void {
		const wrap = container.createDiv({ cls: "annoteca-reply-input-wrap" });
		const textarea = wrap.createEl("textarea", {
			cls: "annoteca-reply-input",
			attr: { placeholder: "Reply…", rows: "3" },
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
			});
		});
	}

	private renderActions(container: HTMLElement, c: Comment): void {
		const actions = container.createDiv({ cls: "annoteca-reviewer-actions" });
		const path = this.activePath;
		if (!path) return;

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
}

// Helper used by the plugin to ensure the reviewer pane shows a specific
// comment. Centralized so commands and clicks share one path.
export function openReviewerOnComment(plugin: AnnotecaPlugin, path: string, comment: Comment): void {
	plugin.events.emit("active-comment-changed", { path, start: comment.marker.start });
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
