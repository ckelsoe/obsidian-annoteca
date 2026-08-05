import { ItemView, WorkspaceLeaf } from 'obsidian';

import type AnnotecaPlugin from './main';
import type { Comment, LocatedComment, CategoryDefinition } from './types';
import { getCategoryOrFallback } from './categories';
import { resolveSettingsCategories } from './settings';
import { serialize } from './parser';
import {
	extractIndexTerm,
	bucketCommentsByHeading,
	type HeadingShape,
	type HeadingBucket,
} from './view-utils';
import { ThreadTabRenderer } from './hub-thread-tab';
import { OutlineTabRenderer } from './hub-outline-tab';
import { StarredTabRenderer } from './hub-starred-tab';

export { extractIndexTerm, bucketCommentsByHeading };
export type { HeadingShape, HeadingBucket };

export const VAULT_UNRESOLVED_VIEW_TYPE = 'annoteca-vault-unresolved-view';
export const INDEX_VIEW_TYPE = 'annoteca-index-view';
export const COMPOSER_PANEL_VIEW_TYPE = 'annoteca-composer-panel-view';
export const ANNOTECA_HUB_VIEW_TYPE = 'annoteca-hub-view';

export type HubTab = 'thread' | 'outline' | 'starred';

// Resolve a stored tab to one the panel can actually draw. `lastHubTab` is
// validated on the way out of data.json, so this should never have work to do;
// it exists because the failure it prevents is silent. An unrecognised value
// left in place renders the Thread panel with no tab lit and no refresh on a
// scope change, which reads as the plugin being broken rather than as a bad
// stored value.
export function normalizeHubTab(tab: unknown): HubTab {
	return tab === 'outline' || tab === 'starred' ? tab : 'thread';
}

// Shared scaffolding for every Annoteca ItemView: plugin injection in the
// constructor and contentEl cleanup on close. Subclasses still own their
// view-type identity methods and onOpen wiring.
abstract class AnnotecaBaseView extends ItemView {
	protected readonly plugin: AnnotecaPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: AnnotecaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}

// Vault-wide unresolved view (F-051, F-052, F-053, F-056) -----------------------

interface VaultFilters {
	pathQuery: string;
	categories: Set<string>;
	state: 'open' | 'resolved' | 'all';
}

export class VaultUnresolvedView extends AnnotecaBaseView {
	private filters: VaultFilters = {
		pathQuery: '',
		categories: new Set(),
		state: 'open',
	};

	getViewType(): string {
		return VAULT_UNRESOLVED_VIEW_TYPE;
	}
	getDisplayText(): string {
		return 'Annoteca: Unresolved';
	}
	getIcon(): string {
		return 'list-checks';
	}

	async onOpen(): Promise<void> {
		await this.plugin.scanVaultIfNeeded();
		this.refresh();
		this.registerEvent(
			this.plugin.events.on('index-changed', () => this.refresh()),
		);
	}

	private refresh(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass('annoteca-view-root');

		container.createEl('h4', { text: 'Vault comments' });

		const toolbar = container.createDiv({ cls: 'annoteca-toolbar' });
		this.renderToolbar(toolbar);

		const results = this.plugin.commentIndex.queryUnresolved({
			resolved: this.filters.state,
			categories:
				this.filters.categories.size > 0
					? this.filters.categories
					: undefined,
		});

		const filtered = this.filters.pathQuery
			? results.filter((r) =>
					r.path
						.toLowerCase()
						.includes(this.filters.pathQuery.toLowerCase()),
				)
			: results;

		if (filtered.length === 0) {
			container.createEl('p', {
				text: 'No comments match these filters.',
				cls: 'annoteca-empty',
			});
			return;
		}

		const enabled = resolveSettingsCategories(this.plugin.settings);
		for (const r of filtered) {
			this.renderRow(container, r, enabled);
		}
	}

	private renderToolbar(toolbar: HTMLElement): void {
		const pathInput = toolbar.createEl('input', {
			cls: 'annoteca-filter-path',
			attr: { type: 'text', placeholder: 'Filter by path…' },
		});
		pathInput.value = this.filters.pathQuery;
		pathInput.addEventListener('input', () => {
			this.filters.pathQuery = pathInput.value;
			this.refresh();
		});

		const stateSelect = toolbar.createEl('select', {
			cls: 'annoteca-filter-state',
		});
		const options: Array<[VaultFilters['state'], string]> = [
			['open', 'Open'],
			['resolved', 'Resolved'],
			['all', 'All'],
		];
		for (const [v, label] of options) {
			const opt = stateSelect.createEl('option', { text: label });
			opt.value = v;
			if (this.filters.state === v) opt.selected = true;
		}
		stateSelect.addEventListener('change', () => {
			this.filters.state = stateSelect.value as VaultFilters['state'];
			this.refresh();
		});

		const catFilters = toolbar.createDiv({
			cls: 'annoteca-filter-categories',
		});
		const enabled = resolveSettingsCategories(this.plugin.settings);
		for (const c of enabled) {
			const label = catFilters.createEl('label', {
				cls: 'annoteca-filter-cat-label',
			});
			const checkbox = label.createEl('input', {
				attr: { type: 'checkbox' },
			});
			checkbox.checked = this.filters.categories.has(c.id);
			checkbox.addEventListener('change', () => {
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
		const row = container.createDiv({ cls: 'annoteca-vault-row' });
		if (located.comment.resolution) row.addClass('annoteca-row-resolved');

		const def = getCategoryOrFallback(located.comment.category, enabled);
		row.createSpan({
			cls: `annoteca-row-category annoteca-cat-${def.id}`,
			text: def.displayName,
		});

		row.createSpan({ cls: 'annoteca-row-path', text: located.path });

		const body =
			located.comment.body.length > 120
				? located.comment.body.slice(0, 120) + '…'
				: located.comment.body;
		row.createSpan({ cls: 'annoteca-row-body', text: body });

		row.addEventListener('click', () => {
			void this.plugin.navigateToComment(
				located.path,
				located.comment.marker.start,
				located.comment,
			);
		});
	}
}

// Index entry view (F-260) -----------------------------------------------------

export class IndexEntryView extends AnnotecaBaseView {
	getViewType(): string {
		return INDEX_VIEW_TYPE;
	}
	getDisplayText(): string {
		return 'Annoteca: Index entries';
	}
	getIcon(): string {
		return 'list';
	}

	async onOpen(): Promise<void> {
		await this.plugin.scanVaultIfNeeded();
		this.refresh();
		this.registerEvent(
			this.plugin.events.on('index-changed', () => this.refresh()),
		);
	}

	private refresh(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass('annoteca-view-root');
		container.createEl('h4', { text: 'Index entries' });

		const entries = this.plugin.commentIndex.queryUnresolved({
			resolved: 'all',
			categories: new Set(['index-entry']),
		});
		if (entries.length === 0) {
			container.createEl('p', {
				text: 'No index entries in this vault yet. Tag concepts with the index-entry category to populate this view.',
				cls: 'annoteca-empty',
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
			const section = container.createDiv({
				cls: 'annoteca-index-section',
			});
			section.createEl('h5', { text: term });
			for (const located of bucket) {
				const row = section.createDiv({ cls: 'annoteca-vault-row' });
				row.createSpan({
					cls: 'annoteca-row-path',
					text: located.path,
				});
				row.createSpan({
					cls: 'annoteca-row-body',
					text: located.comment.body,
				});
				row.addEventListener('click', () => {
					void this.plugin.navigateToComment(
						located.path,
						located.comment.marker.start,
						located.comment,
					);
				});
			}
		}
	}
}

// Composer side-panel view (alternate to the modal) -----------------------------

import { ComposerForm, type ComposerRequest } from './composer';

export class ComposerPanelView extends AnnotecaBaseView {
	private pendingRequest: ComposerRequest | undefined;

	getViewType(): string {
		return COMPOSER_PANEL_VIEW_TYPE;
	}
	getDisplayText(): string {
		return 'Compose comment';
	}
	getIcon(): string {
		return 'message-square-plus';
	}

	setRequest(request: ComposerRequest): void {
		this.pendingRequest = request;
		this.refresh();
	}

	async onOpen(): Promise<void> {
		this.refresh();
	}

	private refresh(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass('annoteca-view-root');

		if (!this.pendingRequest) {
			container.createEl('p', {
				text: 'Trigger the add-comment command from the editor to start a new comment here.',
				cls: 'annoteca-empty',
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

export function serializeReplyAppended(
	c: Comment,
	reply: { author: string; date: string; body: string },
): string {
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

export class AnnotecaPanelView extends AnnotecaBaseView {
	private activeTab: HubTab = 'thread';
	private readonly threadRenderer: ThreadTabRenderer;
	private readonly outlineRenderer: OutlineTabRenderer;
	private readonly starredRenderer: StarredTabRenderer;
	private refreshQueued = false;
	private closed = false;

	constructor(leaf: WorkspaceLeaf, plugin: AnnotecaPlugin) {
		super(leaf, plugin);
		this.threadRenderer = new ThreadTabRenderer(plugin, this.app, () =>
			this.scheduleRefresh(),
		);
		this.outlineRenderer = new OutlineTabRenderer(plugin, this.app);
		this.starredRenderer = new StarredTabRenderer(plugin);
	}

	getViewType(): string {
		return ANNOTECA_HUB_VIEW_TYPE;
	}
	getDisplayText(): string {
		return 'Annoteca';
	}
	getIcon(): string {
		return 'message-square';
	}

	async onOpen(): Promise<void> {
		// Normalized here rather than only at the switch that renders it. The
		// stored value reaches three other places (the tab strip's active
		// marker, and the starred-changed and scope-changed refresh guards), so
		// falling back at render time alone produced a panel showing Thread
		// content with no tab lit and no refresh on a scope change.
		this.activeTab = normalizeHubTab(this.plugin.settings.lastHubTab);
		const file = this.app.workspace.getActiveFile();
		this.threadRenderer.activePath = file?.path;
		this.scheduleRefresh();
		// Scan the vault once so that wider scopes (folder, vault, property,
		// tag) have populated comment data. The first refresh above shows the
		// current file only; when the scan completes it emits "index-changed"
		// and the listener below triggers a second refresh with full data.
		void this.plugin.scanVaultIfNeeded();

		this.registerEvent(
			this.plugin.events.on('active-comment-changed', (payload) => {
				const event = payload as { path: string; start: number };
				this.threadRenderer.activePath = event.path;
				this.threadRenderer.activeStart = event.start;
				// Marker clicks force the Thread tab; the user's intent is to see
				// the comment they clicked, not whatever tab was last viewed.
				this.activeTab = 'thread';
				void this.plugin.setLastHubTab('thread');
				this.scheduleRefresh();
			}),
		);

		this.registerEvent(
			this.plugin.events.on('index-changed', () =>
				this.scheduleRefresh(),
			),
		);
		// The panel reads display settings (markdown rendering, among others)
		// only while rendering, so a setting changed with the panel open leaves
		// every card as it was until some unrelated event happens to refresh.
		// The editor half of this is already handled by
		// refreshDecorationsEverywhere(); this is the panel half.
		this.registerEvent(
			this.plugin.events.on('settings-changed', () =>
				this.scheduleRefresh(),
			),
		);
		this.registerEvent(
			this.plugin.events.on('starred-changed', () => {
				if (this.activeTab === 'starred' || this.activeTab === 'thread')
					this.scheduleRefresh();
			}),
		);
		this.registerEvent(
			this.plugin.events.on('scope-changed', () => {
				if (this.activeTab === 'thread') this.scheduleRefresh();
			}),
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				const f = this.app.workspace.getActiveFile();
				if (!f) return;
				if (f.path === this.threadRenderer.activePath) return;
				this.threadRenderer.activePath = f.path;
				this.threadRenderer.activeStart = undefined;
				this.scheduleRefresh();
			}),
		);
	}

	async onClose(): Promise<void> {
		// Nothing queued may run after this point: a pending render would build
		// a fresh Thread DOM and a fresh markdown lifetime immediately after the
		// dispose below threw the last one away.
		this.closed = true;
		// F-276: dropping the panel deselects the active comment, so clear its
		// editor highlight. The marker decorations themselves are untouched.
		this.plugin.clearActiveCommentHighlight();
		// Unload the last render's markdown lifetime. contentEl.empty() in
		// super.onClose() removes the DOM but not the components attached to it.
		this.threadRenderer.dispose();
		await super.onClose();
	}

	// Coalesce refreshes to one per tick. Several triggers fire for a single
	// user action: starring, changing scope, changing the status filter and
	// switching tabs each have their own refresh path AND persist through
	// saveSettings(), which emits "settings-changed", so every one of them
	// rendered the panel twice. A render is a full contentEl rebuild, and on the
	// Thread tab it walks the vault through computeScopeFiles().
	//
	// Deduping rather than dropping the "settings-changed" listener, which is
	// the tempting fix: that listener is the ONLY refresh path for a plain
	// settings-tab edit, for cycleIndicatorStyle and for the skill-staleness
	// save, so removing it brings back the stale-panel bug it was added for.
	private scheduleRefresh(): void {
		if (this.refreshQueued || this.closed) return;
		this.refreshQueued = true;
		queueMicrotask(() => {
			this.refreshQueued = false;
			if (this.closed) return;
			this.renderPanel();
		});
	}

	private async setActiveTab(tab: HubTab): Promise<void> {
		if (this.activeTab === tab) return;
		this.activeTab = tab;
		await this.plugin.setLastHubTab(tab);
		this.scheduleRefresh();
	}

	// The actual render. Reached only through scheduleRefresh, so no caller can
	// accidentally bypass the coalescing.
	private renderPanel(): void {
		const container = this.contentEl;
		// Unload the previous pass's markdown renders before the DOM they are
		// attached to goes away. Switching to Outline or Starred empties the
		// Thread DOM without rendering Thread again, so without this its embeds
		// and post-processors stay live against detached elements for as long as
		// the user stays on the other tab. Rendering Thread immediately creates a
		// fresh lifetime, so this is safe on every path.
		this.threadRenderer.dispose();
		container.empty();
		container.addClass('annoteca-hub-root');

		this.renderTabStrip(container);

		const content = container.createDiv({ cls: 'annoteca-hub-content' });
		switch (this.activeTab) {
			case 'outline':
				this.outlineRenderer.render(content);
				break;
			case 'starred':
				this.starredRenderer.render(content);
				break;
			// Thread is the default arm, not a case of its own. `activeTab` is
			// already normalized at both places that set it, so this arm should be
			// unreachable; it stays because a switch with no default renders an
			// EMPTY panel, and an empty panel reads as "the plugin is broken"
			// rather than as a bad stored value.
			case 'thread':
			default:
				this.threadRenderer.render(content);
				break;
		}
	}

	private renderTabStrip(container: HTMLElement): void {
		const strip = container.createDiv({ cls: 'annoteca-hub-tabs' });
		const tabs: Array<{ id: HubTab; label: string }> = [
			{ id: 'thread', label: 'Thread' },
			{ id: 'outline', label: 'Outline' },
			{ id: 'starred', label: 'Starred' },
		];
		for (const t of tabs) {
			const btn = strip.createEl('button', {
				cls: `annoteca-hub-tab${this.activeTab === t.id ? ' is-active' : ''}`,
				text: t.label,
			});
			btn.addEventListener('click', () => {
				void this.setActiveTab(t.id);
			});
		}
	}
}
