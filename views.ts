import {
	ItemView,
	WorkspaceLeaf,
} from "obsidian";

import type AnnotecaPlugin from "./main";
import type { Comment, LocatedComment, CategoryDefinition } from "./types";
import { getCategoryOrFallback } from "./categories";
import { resolveSettingsCategories } from "./settings";
import { serialize } from "./parser";
import { extractIndexTerm, bucketCommentsByHeading, type HeadingShape, type HeadingBucket } from "./view-utils";
import { ThreadTabRenderer } from "./hub-thread-tab";
import { OutlineTabRenderer } from "./hub-outline-tab";
import { StarredTabRenderer } from "./hub-starred-tab";

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
	private readonly threadRenderer: ThreadTabRenderer;
	private readonly outlineRenderer: OutlineTabRenderer;
	private readonly starredRenderer: StarredTabRenderer;

	constructor(leaf: WorkspaceLeaf, plugin: AnnotecaPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.threadRenderer = new ThreadTabRenderer(plugin, this.app, () => this.refresh());
		this.outlineRenderer = new OutlineTabRenderer(plugin, this.app);
		this.starredRenderer = new StarredTabRenderer(plugin);
	}

	getViewType(): string { return ANNOTECA_HUB_VIEW_TYPE; }
	getDisplayText(): string { return "Annoteca"; }
	getIcon(): string { return "message-square"; }

	async onOpen(): Promise<void> {
		this.activeTab = this.plugin.settings.lastHubTab;
		const file = this.app.workspace.getActiveFile();
		this.threadRenderer.activePath = file?.path;
		this.refresh();
		// Scan the vault once so that wider scopes (folder, vault, property,
		// tag) have populated comment data. The first refresh above shows the
		// current file only; when the scan completes it emits "index-changed"
		// and the listener below triggers a second refresh with full data.
		void this.plugin.scanVaultIfNeeded();

		this.registerEvent(this.plugin.events.on("active-comment-changed", (payload) => {
			const event = payload as { path: string; start: number };
			this.threadRenderer.activePath = event.path;
			this.threadRenderer.activeStart = event.start;
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
			if (f.path === this.threadRenderer.activePath) return;
			this.threadRenderer.activePath = f.path;
			this.threadRenderer.activeStart = undefined;
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
			case "thread": this.threadRenderer.render(content); break;
			case "outline": this.outlineRenderer.render(content); break;
			case "starred": this.starredRenderer.render(content); break;
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
}
