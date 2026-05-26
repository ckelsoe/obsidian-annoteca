import {
	Editor,
	Events,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TFile,
	getAllTags,
	type WorkspaceLeaf,
} from "obsidian";

import type { AnnotecaSettings, Comment, Reply, ScopeShape, ScopeState, StatusFilter } from "./types";
import { CommentIndex } from "./index";
import { DEFAULT_SETTINGS, AnnotecaSettingTab } from "./settings";
import { AddCommentModal } from "./modal";
import {
	buildAnnotecaExtension,
	setHideAllComments,
} from "./decorations";
import {
	VAULT_UNRESOLVED_VIEW_TYPE,
	VaultUnresolvedView,
	INDEX_VIEW_TYPE,
	IndexEntryView,
	COMPOSER_PANEL_VIEW_TYPE,
	ComposerPanelView,
	ANNOTECA_HUB_VIEW_TYPE,
	AnnotecaPanelView,
} from "./views";
import type { ComposerRequest } from "./composer";
import {
	detectMarkerConflicts,
	detectOrphans,
	validateMarkers,
	type OrphanFinding,
	type ConflictFinding,
	type ValidationFinding,
} from "./diagnostics";
import { serialize, todayISO } from "./parser";
import { convertAllComments, type ImportFormat } from "./imports";
import { ConfirmBackupModal } from "./confirm-modal";
import { detectDrift, type DriftFinding, type PositionSnapshot } from "./drift";
import { formatScripture } from "./scripture";

class AnnotecaEvents extends Events {
	emit(name: string, ...data: unknown[]): void {
		this.trigger(name, ...data);
	}
}

export default class AnnotecaPlugin extends Plugin {
	settings!: AnnotecaSettings;
	commentIndex = new CommentIndex();
	events = new AnnotecaEvents();
	private vaultScanned = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerEditorExtension(buildAnnotecaExtension({
			getSettings: () => this.settings,
			onMarkerClick: (m) => this.openReviewerOnComment(m),
			openInReviewer: (m) => this.openReviewerOnComment(m),
			toggleResolution: (m) => { void this.toggleResolutionFromPopup(m); },
			copyPermalink: (m) => { void this.copyCommentId(m); },
			submitReply: (m, body) => { void this.submitReplyFromPopup(m, body); },
			getAuthorTag: () => this.resolvedAuthor(),
			isStarred: (m) => this.isStarred(m),
			toggleStarred: (m) => { void this.toggleStarred(m); },
			loadDraft: (id) => this.loadDraft(id),
			saveDraft: (id, body) => this.saveDraft(id, body),
			clearDraft: (id) => this.clearDraft(id),
		}));

		this.registerView(ANNOTECA_HUB_VIEW_TYPE, leaf => new AnnotecaPanelView(leaf, this));
		this.registerView(VAULT_UNRESOLVED_VIEW_TYPE, leaf => new VaultUnresolvedView(leaf, this));
		this.registerView(INDEX_VIEW_TYPE, leaf => new IndexEntryView(leaf, this));
		this.registerView(COMPOSER_PANEL_VIEW_TYPE, leaf => new ComposerPanelView(leaf, this));

		this.addSettingTab(new AnnotecaSettingTab(this.app, this));

		this.registerCommands();
		this.registerFileEvents();
		this.registerEditorMenu();

		this.addRibbonIcon("message-square", "Annoteca: open comments pane", () => {
			void this.activateView(ANNOTECA_HUB_VIEW_TYPE, "right");
		});

		this.applyIndicatorSize();
		this.applyAnchorAppearance();

		this.app.workspace.onLayoutReady(() => {
			this.refreshActiveFileIndex();
			this.ensureRightSidebarTab();
		});
	}

	// Apply the indicator-size setting to a body-level CSS variable so the
	// marker styling in styles.css can scale dynamically without recreating
	// the editor extension. Called on load and on settings change.
	applyIndicatorSize(): void {
		const sizes: Record<AnnotecaSettings["indicatorSize"], string> = {
			small: "0.85em",
			medium: "1em",
			large: "1.25em",
		};
		activeDocument.body.style.setProperty(
			"--annoteca-indicator-size",
			sizes[this.settings.indicatorSize],
		);
	}

	// Apply the anchor-underline style + baseline thickness + resolved
	// brightness to body-level CSS variables. styles.css consumes them for
	// the .annoteca-anchor rule, the per-tier overrides, and the .annoteca-
	// resolved opacity. Called on load and on settings change.
	applyAnchorAppearance(): void {
		const thicknesses: Record<AnnotecaSettings["anchorThickness"], string> = {
			thin: "1px",
			medium: "2px",
			thick: "3px",
		};
		const resolvedOpacities: Record<AnnotecaSettings["resolvedBrightness"], string> = {
			normal: "0.5",
			bright: "0.85",
		};
		activeDocument.body.style.setProperty(
			"--annoteca-anchor-style",
			this.settings.anchorStyle,
		);
		activeDocument.body.style.setProperty(
			"--annoteca-anchor-thickness-normal",
			thicknesses[this.settings.anchorThickness],
		);
		activeDocument.body.style.setProperty(
			"--annoteca-resolved-opacity",
			resolvedOpacities[this.settings.resolvedBrightness],
		);
	}

	private ensureRightSidebarTab(): void {
		// Place the reviewer pane in the right sidebar on first load so its
		// tab icon shows up alongside backlinks, tags, and the other native
		// right-pane tools. If a user has explicitly closed it, this won't
		// reopen on subsequent loads because the leaf record persists across
		// sessions and we only add when none exists.
		const existing = this.app.workspace.getLeavesOfType(ANNOTECA_HUB_VIEW_TYPE);
		if (existing.length > 0) return;
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		void leaf.setViewState({ type: ANNOTECA_HUB_VIEW_TYPE, active: false });
	}

	onunload(): void {
		// Obsidian disposes registered commands, views, events, and editor
		// extensions automatically. Nothing custom to clean up.
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<AnnotecaSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}), indicatorStyle: DEFAULT_SETTINGS.indicatorStyle };

		// Migrate legacy indicatorStyle values. Prior to the underline rewrite,
		// "gutter" meant the (misplaced) left-margin dot and "inline" meant the
		// in-prose ◆ widget. New names are "icon" and "underline" respectively.
		// Use unknown-string compares so TypeScript doesn't narrow the union.
		const legacy = (loaded?.indicatorStyle as string | undefined);
		if (legacy === "gutter") this.settings.indicatorStyle = "icon";
		else if (legacy === "inline") this.settings.indicatorStyle = "underline";
		else if (legacy === "icon" || legacy === "underline" || legacy === "both" || legacy === "none") {
			this.settings.indicatorStyle = legacy;
		}

		if (!this.settings.categories || this.settings.categories.length === 0) {
			this.settings.categories = [...DEFAULT_SETTINGS.categories];
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.events.emit("settings-changed");
	}

	private registerFileEvents(): void {
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file instanceof TFile && file.extension === "md") {
				void this.rebuildIndexForFile(file);
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (file instanceof TFile) {
				this.commentIndex.rename(oldPath, file.path);
				this.events.emit("index-changed");
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (file instanceof TFile) {
				this.commentIndex.remove(file.path);
				this.events.emit("index-changed");
			}
		}));
		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			if (file && file.extension === "md") {
				void this.rebuildIndexForFile(file);
				this.onActiveFileChangedForScope(file);
			}
		}));
	}

	private registerEditorMenu(): void {
		this.registerEvent(this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
			menu.addSeparator();
			if (editor.getSelection().length > 0) {
				menu.addItem(item => item
					.setTitle("Annoteca: add comment for selection")
					.setIcon("message-square-plus")
					.onClick(() => this.openModalForSelection(editor)));
			} else {
				menu.addItem(item => item
					.setTitle("Annoteca: add comment here")
					.setIcon("message-square-plus")
					.onClick(() => this.openModalAtCursor(editor)));
			}

			const file = view.file;
			if (!file) return;
			const idx = this.commentIndex.get(file.path);
			if (!idx) return;
			const cursorOffset = editor.posToOffset(editor.getCursor());
			const inside = idx.comments.find(c =>
				cursorOffset >= c.marker.start && cursorOffset <= c.marker.end,
			);
			if (!inside) return;

			menu.addItem(item => item
				.setTitle("Annoteca: edit comment")
				.setIcon("pencil")
				.onClick(() => this.openEditModal(editor, file.path, inside)));
			if (inside.resolution) {
				menu.addItem(item => item
					.setTitle("Annoteca: reopen comment")
					.setIcon("rotate-ccw")
					.onClick(() => { void this.reopenComment(file.path, inside); }));
			} else {
				menu.addItem(item => item
					.setTitle("Annoteca: resolve comment")
					.setIcon("check")
					.onClick(() => { void this.resolveComment(file.path, inside); }));
			}
			menu.addItem(item => item
				.setTitle("Annoteca: reply to comment")
				.setIcon("reply")
				.onClick(() => this.openReviewerOnComment(inside, file.path)));
			menu.addItem(item => item
				.setTitle("Annoteca: delete comment")
				.setIcon("trash")
				.onClick(() => { void this.deleteComment(file.path, inside); }));
		}));
	}

	private registerCommands(): void {
		this.addCommand({
			id: "add-comment-at-cursor",
			name: "Add comment here",
			editorCallback: (editor: Editor) => this.openModalAtCursor(editor),
		});
		this.addCommand({
			id: "add-comment-for-selection",
			name: "Add comment for selection",
			editorCallback: (editor: Editor) => this.openModalForSelection(editor),
		});
		this.addCommand({
			id: "add-scratchpad-comment",
			name: "Add scratchpad comment",
			editorCallback: (editor: Editor) => this.openScratchpadModal(editor),
		});
		this.addCommand({
			id: "edit-comment-at-cursor",
			name: "Edit comment here",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withCommentAtCursor(editor, view, (path, c) => this.openEditModal(editor, path, c));
			},
		});
		this.addCommand({
			id: "delete-comment-at-cursor",
			name: "Delete comment here",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withCommentAtCursor(editor, view, (path, c) => { void this.deleteComment(path, c); });
			},
		});
		this.addCommand({
			id: "resolve-comment-at-cursor",
			name: "Resolve comment here",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withCommentAtCursor(editor, view, (path, c) => { void this.resolveComment(path, c); });
			},
		});
		this.addCommand({
			id: "reopen-comment-at-cursor",
			name: "Reopen resolved comment here",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withCommentAtCursor(editor, view, (path, c) => { void this.reopenComment(path, c); });
			},
		});
		this.addCommand({
			id: "reply-to-comment-at-cursor",
			name: "Reply to comment here",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withCommentAtCursor(editor, view, (path, c) => this.openReviewerOnComment(c, path));
			},
		});
		this.addCommand({
			id: "next-comment",
			name: "Next comment",
			editorCallback: (editor: Editor, view: MarkdownView) => { void this.jumpToAdjacentComment(editor, view, "next", false); },
		});
		this.addCommand({
			id: "previous-comment",
			name: "Previous comment",
			editorCallback: (editor: Editor, view: MarkdownView) => { void this.jumpToAdjacentComment(editor, view, "previous", false); },
		});
		this.addCommand({
			id: "next-unresolved-comment",
			name: "Next unresolved comment",
			editorCallback: (editor: Editor, view: MarkdownView) => { void this.jumpToAdjacentComment(editor, view, "next", true); },
		});
		this.addCommand({
			id: "previous-unresolved-comment",
			name: "Previous unresolved comment",
			editorCallback: (editor: Editor, view: MarkdownView) => { void this.jumpToAdjacentComment(editor, view, "previous", true); },
		});
		this.addCommand({
			id: "toggle-hide-all-comments",
			name: "Toggle hide-all-comments mode",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const cm = (view.editor as unknown as { cm?: unknown }).cm;
				if (!cm) return;
				const currentlyHidden = this.toggleHideAllForActiveView(view);
				new Notice(currentlyHidden ? "Comments hidden." : "Comments visible.");
			},
		});
		this.addCommand({
			id: "cycle-indicator-style",
			name: "Cycle indicator style",
			callback: () => { void this.cycleIndicatorStyle(); },
		});
		this.addCommand({
			id: "open-hub",
			name: "Open comments panel",
			callback: () => { void this.activateView(ANNOTECA_HUB_VIEW_TYPE, "right"); },
		});
		this.addCommand({
			id: "open-vault-unresolved-view",
			name: "Open unresolved comments view",
			callback: () => { void this.activateView(VAULT_UNRESOLVED_VIEW_TYPE, "tab"); },
		});
		this.addCommand({
			id: "open-index-view",
			name: "Open index entries view",
			callback: () => { void this.activateView(INDEX_VIEW_TYPE, "tab"); },
		});
		this.addCommand({
			id: "check-marker-conflicts",
			name: "Check for marker conflicts",
			callback: () => { void this.runConflictCheck(); },
		});
		this.addCommand({
			id: "detect-orphan-comments",
			name: "Detect orphan comments",
			callback: () => { void this.runOrphanCheck(); },
		});
		this.addCommand({
			id: "validate-marker-format",
			name: "Validate marker format",
			callback: () => { void this.runMarkerValidation(); },
		});
		this.addCommand({
			id: "format-scripture-references",
			name: "Format scripture references in current file",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const file = view.file;
				if (!file) return;
				const text = editor.getValue();
				const r = formatScripture(text);
				if (r.changes === 0) {
					new Notice("No scripture references to format.");
					return;
				}
				editor.setValue(r.updated);
				new Notice(`Formatted ${r.changes} reference(s).`);
			},
		});
		this.addCommand({
			id: "backup-settings",
			name: "Back up settings",
			callback: () => { void this.backupSettings(); },
		});
		this.addCommand({
			id: "restore-settings",
			name: "Restore settings from backup",
			callback: () => { void this.restoreSettings(); },
		});
		this.addCommand({
			id: "self-diagnostic",
			name: "Run self-diagnostic",
			callback: () => { void this.runSelfDiagnostic(); },
		});
		this.addCommand({
			id: "detect-position-drift",
			name: "Detect position drift",
			callback: () => { void this.runDriftCheck(); },
		});
		this.addCommand({
			id: "import-native-comments",
			name: "Import native Obsidian comments",
			callback: () => this.confirmAndConvert("native"),
		});
		this.addCommand({
			id: "import-html-comments",
			name: "Import generic HTML comments",
			callback: () => this.confirmAndConvert("html"),
		});
		this.addCommand({
			id: "import-all-comments",
			name: "Convert every comment to the canonical format",
			callback: () => this.confirmAndConvert("all"),
		});
	}

	// File / index helpers ------------------------------------------------

	private async rebuildIndexForFile(file: TFile): Promise<void> {
		const content = await this.app.vault.cachedRead(file);
		this.commentIndex.rebuild(file.path, content);
		this.events.emit("index-changed", { path: file.path });
	}

	async scanVaultIfNeeded(): Promise<void> {
		if (this.vaultScanned) return;
		const files = this.app.vault.getMarkdownFiles();
		for (const f of files) {
			const content = await this.app.vault.cachedRead(f);
			this.commentIndex.rebuild(f.path, content);
		}
		this.vaultScanned = true;
		this.events.emit("index-changed");
	}

	private refreshActiveFileIndex(): void {
		const active = this.app.workspace.getActiveFile();
		if (active && active.extension === "md") {
			void this.rebuildIndexForFile(active);
		}
	}

	// Composer openers (modal or side panel based on setting) -----------

	private openModalAtCursor(editor: Editor): void {
		const path = this.app.workspace.getActiveFile()?.path;
		if (!path) return;
		this.openComposer({ editor, filePath: path });
	}

	private openModalForSelection(editor: Editor): void {
		const path = this.app.workspace.getActiveFile()?.path;
		if (!path) return;
		this.openComposer({ editor, filePath: path });
	}

	private openScratchpadModal(editor: Editor): void {
		const path = this.app.workspace.getActiveFile()?.path;
		if (!path) return;
		this.openComposer({ editor, filePath: path, scratchpad: true });
	}

	private openEditModal(editor: Editor, path: string, comment: Comment): void {
		const from = editor.offsetToPos(comment.marker.start);
		const to = editor.offsetToPos(comment.marker.end);
		this.openComposer({
			editor,
			filePath: path,
			editing: { comment, from, to },
		});
	}

	private openComposer(request: ComposerRequest): void {
		if (this.settings.composerLocation === "panel") {
			void this.openComposerPanel(request);
		} else {
			new AddCommentModal(this.app, this, request).open();
		}
	}

	private async openComposerPanel(request: ComposerRequest): Promise<void> {
		await this.activateView(COMPOSER_PANEL_VIEW_TYPE, "right");
		const leaves = this.app.workspace.getLeavesOfType(COMPOSER_PANEL_VIEW_TYPE);
		const view = leaves[0]?.view;
		if (view instanceof ComposerPanelView) view.setRequest(request);
	}

	async notifyComposerSubmitted(path: string, markerStart: number): Promise<void> {
		// Snapshot the current editor text and rebuild the index so the new
		// (or edited) marker is queryable before the vault.modify event lands.
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			const content = view?.editor.getValue() ?? await this.app.vault.cachedRead(file);
			this.commentIndex.rebuild(path, content);
		}
		this.events.emit("index-changed", { path });
		this.events.emit("active-comment-changed", { path, start: markerStart });
		await this.activateView(ANNOTECA_HUB_VIEW_TYPE, "right");
	}

	// Comment lifecycle operations ---------------------------------------

	async resolveComment(path: string, comment: Comment): Promise<void> {
		if (comment.resolution) return;
		const author = this.resolvedAuthor();
		const resolved: Comment = {
			...comment,
			resolution: { author, date: todayISO(), note: "" },
		};
		await this.replaceMarker(path, comment, resolved);
		new Notice("Resolved.");
	}

	async reopenComment(path: string, comment: Comment): Promise<void> {
		if (!comment.resolution) return;
		const reopened: Comment = { ...comment, resolution: undefined };
		await this.replaceMarker(path, comment, reopened);
		new Notice("Reopened.");
	}

	async deleteComment(path: string, comment: Comment): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);
		// Drop the marker plus any trailing space introduced by range insertion.
		let start = comment.marker.start;
		let end = comment.marker.end;
		if (start > 0 && content.charAt(start - 1) === " ") start -= 1;
		const updated = content.slice(0, start) + content.slice(end);
		await this.app.vault.modify(file, updated);
		this.commentIndex.rebuild(path, updated);
		this.events.emit("index-changed", { path });
		new Notice("Deleted.");
	}

	async appendReply(comment: Comment, reply: Reply): Promise<void> {
		const path = this.app.workspace.getActiveFile()?.path;
		if (!path) return;
		const updated: Comment = {
			...comment,
			replies: [...comment.replies, reply],
		};
		await this.replaceMarker(path, comment, updated);
	}

	async toggleResolutionFromPopup(comment: Comment): Promise<void> {
		const path = this.app.workspace.getActiveFile()?.path;
		if (!path) return;
		if (comment.resolution) {
			await this.reopenComment(path, comment);
		} else {
			await this.resolveComment(path, comment);
		}
	}

	async submitReplyFromPopup(comment: Comment, body: string): Promise<void> {
		const trimmed = body.trim();
		if (trimmed.length === 0) return;
		const reply: Reply = {
			author: this.resolvedAuthor(),
			date: todayISO(),
			body: trimmed,
		};
		await this.appendReply(comment, reply);
		new Notice("Reply added.");
	}

	async copyCommentId(comment: Comment): Promise<void> {
		if (!comment.id) {
			new Notice("This comment has no ID.");
			return;
		}
		await navigator.clipboard.writeText(comment.id);
		new Notice(`Copied ID ${comment.id}.`);
	}

	// Starred comments ---------------------------------------------------

	isStarred(comment: Comment): boolean {
		if (!comment.id) return false;
		return this.settings.starredComments.includes(comment.id);
	}

	async toggleStarred(comment: Comment): Promise<void> {
		if (!comment.id) {
			new Notice("This comment has no ID and cannot be starred.");
			return;
		}
		const current = this.settings.starredComments;
		const idx = current.indexOf(comment.id);
		if (idx >= 0) {
			current.splice(idx, 1);
		} else {
			current.push(comment.id);
		}
		await this.saveSettings();
		this.events.emit("starred-changed", { id: comment.id });
	}

	async setLastHubTab(tab: AnnotecaSettings["lastHubTab"]): Promise<void> {
		if (this.settings.lastHubTab === tab) return;
		this.settings.lastHubTab = tab;
		await this.saveSettings();
	}

	// Reply draft persistence (vault-local, not synced) ------------------
	// Keyed by comment id. Saved on textarea input (debounced by callers);
	// loaded when the composer popup opens; cleared on Send.

	loadDraft(commentId: string): string {
		const raw: unknown = this.app.loadLocalStorage(this.draftKey(commentId));
		return typeof raw === "string" ? raw : "";
	}

	saveDraft(commentId: string, body: string): void {
		if (body.length === 0) {
			this.clearDraft(commentId);
			return;
		}
		this.app.saveLocalStorage(this.draftKey(commentId), body);
	}

	clearDraft(commentId: string): void {
		this.app.saveLocalStorage(this.draftKey(commentId), null);
	}

	private draftKey(commentId: string): string {
		return `annoteca:draft:${commentId}`;
	}

	editCommentFromReviewer(path: string, comment: Comment): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("Open the file to edit this comment.");
			return;
		}
		this.openEditModal(view.editor, path, comment);
	}

	// Marker replacement (shared by resolve / reopen / reply / edit) ------

	private async replaceMarker(path: string, prev: Comment, next: Comment): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);
		const serialized = serialize({
			id: next.id,
			category: next.category,
			body: next.body,
			date: next.date,
			author: next.author,
			anchor: next.anchor,
			replies: next.replies,
			resolution: next.resolution,
		});
		const updated = content.slice(0, prev.marker.start) + serialized + content.slice(prev.marker.end);
		await this.app.vault.modify(file, updated);
		this.commentIndex.rebuild(path, updated);
		this.events.emit("index-changed", { path });
	}

	private resolvedAuthor(): string {
		const tag = this.settings.authorTag.trim();
		if (this.settings.enableAuthorTag && tag !== "") return tag;
		return "user";
	}

	// Scope state --------------------------------------------------------
	//
	// The Thread tab can show comments scoped to a single file, a folder, a
	// folder tree, the whole vault, or files matching a frontmatter property
	// or tag. Scope state persists across restarts via settings; it is also
	// auto-collapsed to "this file" when the user navigates outside the
	// current scope and the scope is not pinned.

	getScopeState(): ScopeState {
		return this.settings.scopeState;
	}

	async setScopeShape(shape: ScopeShape, anchorPath: string): Promise<void> {
		this.settings.scopeState = { shape, anchorPath, pinned: this.settings.scopeState.pinned };
		await this.saveSettings();
		this.events.emit("scope-changed");
	}

	async togglePinScope(): Promise<void> {
		this.settings.scopeState.pinned = !this.settings.scopeState.pinned;
		await this.saveSettings();
		this.events.emit("scope-changed");
	}

	async setStatusFilter(f: StatusFilter): Promise<void> {
		if (this.settings.statusFilter === f) return;
		this.settings.statusFilter = f;
		await this.saveSettings();
		this.events.emit("scope-changed");
	}

	// Returns the set of vault-relative file paths that satisfy the current
	// scope shape. For tag/property scope, queries the metadata cache. For
	// folder scope, prefix-matches against vault paths. For vault scope,
	// returns every markdown file.
	computeScopeFiles(): Set<string> {
		const state = this.settings.scopeState;
		const out = new Set<string>();
		const allFiles = this.app.vault.getMarkdownFiles();

		switch (state.shape.kind) {
			case "file": {
				if (state.anchorPath) out.add(state.anchorPath);
				else {
					const active = this.app.workspace.getActiveFile();
					if (active) out.add(active.path);
				}
				break;
			}
			case "folder": {
				const folder = state.anchorPath;
				const subfolders = state.shape.subfolders;
				for (const f of allFiles) {
					if (subfolders) {
						if (folder === "" || f.path.startsWith(folder + "/") || f.parent?.path === folder) {
							out.add(f.path);
						}
					} else {
						if ((folder === "" && f.parent?.isRoot()) || f.parent?.path === folder) {
							out.add(f.path);
						}
					}
				}
				break;
			}
			case "vault": {
				for (const f of allFiles) out.add(f.path);
				break;
			}
			case "property": {
				const { key, value } = state.shape;
				for (const f of allFiles) {
					const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
					if (!fm) continue;
					const v: unknown = fm[key];
					if (Array.isArray(v) ? v.includes(value) : v === value) out.add(f.path);
				}
				break;
			}
			case "tag": {
				const target = state.shape.tag.startsWith("#") ? state.shape.tag : "#" + state.shape.tag;
				for (const f of allFiles) {
					const cache = this.app.metadataCache.getFileCache(f);
					if (!cache) continue;
					const tags = getAllTags(cache);
					if (tags && tags.includes(target)) out.add(f.path);
				}
				break;
			}
		}
		return out;
	}

	// Called when the workspace's active file changes. If the new file falls
	// outside the current scope and the scope is not pinned, collapse the
	// scope to "this file" so the panel keeps showing relevant content. When
	// the new file is inside the current scope, leave the scope alone.
	private onActiveFileChangedForScope(file: TFile): void {
		const state = this.settings.scopeState;
		if (state.pinned) return;
		if (state.shape.kind === "vault") return;
		if (state.shape.kind === "file") {
			// Single-file scope always follows the active file.
			if (state.anchorPath !== file.path) {
				void this.setScopeShape({ kind: "file" }, file.path);
			}
			return;
		}
		const inScope = this.computeScopeFiles().has(file.path);
		if (!inScope) {
			void this.setScopeShape({ kind: "file" }, file.path);
		}
	}

	// Scope options for the dropdown that depend on the active file's
	// metadata. Returns the set of properties (key/value pairs) and tags
	// present on the active file that could be used as scope sources.
	getDynamicScopeOptionsForActiveFile(): {
		properties: Array<{ key: string; value: string }>;
		tags: string[];
	} {
		const active = this.app.workspace.getActiveFile();
		const result = { properties: [] as Array<{ key: string; value: string }>, tags: [] as string[] };
		if (!active) return result;
		const cache = this.app.metadataCache.getFileCache(active);
		if (!cache) return result;
		if (cache.frontmatter) {
			for (const [key, raw] of Object.entries(cache.frontmatter)) {
				if (key === "position") continue;
				if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
					result.properties.push({ key, value: String(raw) });
				} else if (Array.isArray(raw)) {
					for (const v of raw) {
						if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
							result.properties.push({ key, value: String(v) });
						}
					}
				}
			}
		}
		const tags = getAllTags(cache);
		if (tags) result.tags.push(...tags);
		return result;
	}

	// Navigation ---------------------------------------------------------

	async navigateToComment(path: string, start: number, comment?: Comment): Promise<void> {
		await this.navigateToOffset(path, start);
		if (comment) this.openReviewerOnComment(comment, path);
	}

	async navigateToOffset(path: string, offset: number): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice("File not found.");
			return;
		}

		// Find an existing markdown leaf showing this file. We cannot rely on
		// getActiveViewOfType(MarkdownView) here because the call site is often
		// the hub panel (right sidebar), which is the active leaf when the
		// user clicks a navigate button. The active view in that moment is
		// the hub, not a MarkdownView, so the cursor + scroll calls would be
		// gated out and produce a silent no-op.
		let targetLeaf: WorkspaceLeaf | null = null;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			if (view.file?.path === path) {
				targetLeaf = leaf;
				break;
			}
		}
		if (!targetLeaf) {
			targetLeaf = this.app.workspace.getLeaf("tab");
			await targetLeaf.openFile(file);
		}

		const view = targetLeaf.view as MarkdownView;
		const pos = view.editor.offsetToPos(offset);
		view.editor.setCursor(pos);
		view.editor.scrollIntoView({ from: pos, to: pos }, true);
		this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
	}

	private async jumpToAdjacentComment(
		editor: Editor,
		view: MarkdownView,
		direction: "next" | "previous",
		unresolvedOnly: boolean,
	): Promise<void> {
		const currentFile = view.file;
		if (!currentFile) return;

		// Gather every comment in the current scope across all files. The
		// "next/previous" navigation walks this combined list so users can
		// triage by chapter or by book without bouncing back to single-file.
		interface Located { path: string; comment: Comment; }
		const scopeFiles = this.computeScopeFiles();
		const all: Located[] = [];
		for (const path of scopeFiles) {
			const idx = this.commentIndex.get(path);
			if (!idx) continue;
			for (const c of idx.comments) {
				if (unresolvedOnly && c.resolution) continue;
				all.push({ path, comment: c });
			}
		}
		if (all.length === 0) {
			new Notice("No matching comments in scope.");
			return;
		}

		// Sort by (path, offset). Path sort is alphabetical, which is the
		// same order the hub Thread tab uses, so navigation matches the panel.
		all.sort((a, b) => {
			if (a.path !== b.path) return a.path < b.path ? -1 : 1;
			return a.comment.marker.start - b.comment.marker.start;
		});

		const cursorOffset = editor.posToOffset(editor.getCursor());
		const currentPath = currentFile.path;
		let target: Located | undefined;

		if (direction === "next") {
			target = all.find(item => {
				if (item.path < currentPath) return false;
				if (item.path > currentPath) return true;
				return item.comment.marker.start > cursorOffset;
			});
			target = target ?? all[0]; // wrap to start of scope
		} else {
			for (let i = all.length - 1; i >= 0; i--) {
				const item = all[i];
				if (!item) continue;
				if (item.path > currentPath) continue;
				if (item.path < currentPath || item.comment.marker.start < cursorOffset) {
					target = item;
					break;
				}
			}
			target = target ?? all[all.length - 1]; // wrap to end of scope
		}

		if (!target) return;
		await this.navigateToOffset(target.path, target.comment.marker.start);
		this.openReviewerOnComment(target.comment, target.path);
	}

	// Reviewer pane wiring ----------------------------------------------

	openReviewerOnComment(comment: Comment, path?: string): void {
		const filePath = path ?? this.app.workspace.getActiveFile()?.path;
		if (!filePath) return;
		const start = comment.marker.start;
		// Activate the view first so its active-comment-changed listener exists
		// before we emit. If the view is newly created, setViewState resolves
		// after onOpen runs and the listener is registered. If the view is
		// already open, the listener is registered from its earlier onOpen.
		// Emitting before activation lost the event on first open and made
		// the panel fall back to comments[0] (the first item).
		void this.activateView(ANNOTECA_HUB_VIEW_TYPE, "right").then(() => {
			this.events.emit("active-comment-changed", { path: filePath, start });
		});
	}

	// Display toggles ----------------------------------------------------

	private toggleHideAllForActiveView(view: MarkdownView): boolean {
		const cmView = (view.editor as unknown as { cm: import("@codemirror/view").EditorView }).cm;
		const currentlyHidden = (cmView as unknown as { __annotecaHidden?: boolean }).__annotecaHidden ?? false;
		const next = !currentlyHidden;
		(cmView as unknown as { __annotecaHidden?: boolean }).__annotecaHidden = next;
		setHideAllComments(cmView, next);
		return next;
	}

	private async cycleIndicatorStyle(): Promise<void> {
		const order: AnnotecaSettings["indicatorStyle"][] = ["both", "icon", "underline", "none"];
		const idx = order.indexOf(this.settings.indicatorStyle);
		const next = order[(idx + 1) % order.length] ?? "both";
		this.settings.indicatorStyle = next;
		await this.saveSettings();
		new Notice(`Indicator style: ${next}.`);
	}

	// Diagnostics commands ----------------------------------------------

	private async runConflictCheck(): Promise<void> {
		await this.scanVaultIfNeeded();
		const findings: ConflictFinding[] = [];
		const files = this.app.vault.getMarkdownFiles();
		for (const f of files) {
			const content = await this.app.vault.cachedRead(f);
			findings.push(...detectMarkerConflicts(content, f.path));
		}
		if (findings.length === 0) {
			new Notice("No marker conflicts detected.");
			return;
		}
		await this.writeDiagnosticsReport("Marker conflicts", findings);
		new Notice(`Found ${findings.length} potential conflict(s). See the diagnostics note in the vault.`);
	}

	private async runOrphanCheck(): Promise<void> {
		await this.scanVaultIfNeeded();
		const findings: OrphanFinding[] = [];
		const files = this.app.vault.getMarkdownFiles();
		for (const f of files) {
			const content = await this.app.vault.cachedRead(f);
			findings.push(...detectOrphans(content, f.path));
		}
		if (findings.length === 0) {
			new Notice("No orphan comments detected.");
			return;
		}
		await this.writeDiagnosticsReport("Orphan comments", findings);
		new Notice(`Found ${findings.length} orphan(s). See the diagnostics note in the vault.`);
	}

	private async backupSettings(): Promise<void> {
		const filename = this.settings.settingsBackupPath ?? `Annoteca settings backup.json`;
		const exportable = { ...this.settings };
		delete exportable.driftSnapshots;
		const body = JSON.stringify(exportable, null, 2);
		const existing = this.app.vault.getAbstractFileByPath(filename);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, body);
		} else {
			await this.app.vault.create(filename, body);
		}
		new Notice(`Backed up to ${filename}.`);
	}

	private async restoreSettings(): Promise<void> {
		const filename = this.settings.settingsBackupPath ?? `Annoteca settings backup.json`;
		const file = this.app.vault.getAbstractFileByPath(filename);
		if (!(file instanceof TFile)) {
			new Notice(`Backup file not found: ${filename}.`);
			return;
		}
		const body = await this.app.vault.read(file);
		try {
			const parsed = JSON.parse(body) as Partial<AnnotecaSettings>;
			this.settings = { ...DEFAULT_SETTINGS, ...this.settings, ...parsed };
			await this.saveSettings();
			new Notice("Settings restored.");
		} catch {
			new Notice("Backup file is not valid JSON.");
		}
	}

	private async runSelfDiagnostic(): Promise<void> {
		await this.scanVaultIfNeeded();
		const stats = this.commentIndex.stats();
		const enabled = this.settings.categories.length;
		const summary = {
			fileCount: stats.fileCount,
			commentCount: stats.commentCount,
			unresolvedCount: stats.unresolvedCount,
			enabledCategories: enabled,
			scholarlyPreset: this.settings.enableScholarlyPreset,
			indicatorStyle: this.settings.indicatorStyle,
			authorTagEnabled: this.settings.enableAuthorTag,
			debugMode: this.settings.debugMode,
		};
		await this.writeDiagnosticsReport("Self-diagnostic", [summary]);
		new Notice(`Plugin healthy. ${stats.commentCount} comment(s) indexed across ${stats.fileCount} file(s).`);
	}

	private async runDriftCheck(): Promise<void> {
		await this.scanVaultIfNeeded();
		const prior: Record<string, PositionSnapshot> = this.settings.driftSnapshots ?? {};
		const allFindings: DriftFinding[] = [];
		let refreshed: Record<string, PositionSnapshot> = { ...prior };
		const files = this.app.vault.getMarkdownFiles();
		const liveIds = new Set<string>();
		for (const f of files) {
			const content = await this.app.vault.cachedRead(f);
			const idx = this.commentIndex.get(f.path);
			const comments = idx?.comments ?? [];
			for (const c of comments) if (c.id) liveIds.add(c.id);
			const r = detectDrift(content, f.path, comments, refreshed);
			refreshed = r.refreshedSnapshots;
			allFindings.push(...r.findings);
		}
		for (const id of Object.keys(refreshed)) {
			if (!liveIds.has(id)) delete refreshed[id];
		}
		this.settings.driftSnapshots = refreshed;
		await this.saveSettings();

		if (allFindings.length === 0) {
			new Notice("No position drift detected. Snapshots refreshed.");
			return;
		}
		await this.writeDiagnosticsReport("Position drift", allFindings);
		new Notice(`Found ${allFindings.length} drift finding(s). See the diagnostics note in the vault.`);
	}

	private async runMarkerValidation(): Promise<void> {
		const findings: ValidationFinding[] = [];
		const files = this.app.vault.getMarkdownFiles();
		for (const f of files) {
			const content = await this.app.vault.cachedRead(f);
			findings.push(...validateMarkers(content, f.path));
		}
		if (findings.length === 0) {
			new Notice("All markers are valid.");
			return;
		}
		await this.writeDiagnosticsReport("Malformed markers", findings);
		new Notice(`Found ${findings.length} malformed marker(s). See the diagnostics note in the vault.`);
	}

	private confirmAndConvert(format: ImportFormat): void {
		const description = format === "native"
			? "Convert every %%comment%% in the vault into an Annoteca marker with the 'uncategorized' category."
			: format === "html"
				? "Convert every plain HTML comment in the vault (anything not already in Annoteca format) into an Annoteca marker with the 'uncategorized' category."
				: "Convert every native and plain HTML comment in the vault into Annoteca markers with the 'uncategorized' category.";
		new ConfirmBackupModal(this.app, "Convert comments", description, () => {
			void this.runBulkConvert(format);
		}).open();
	}

	private async runBulkConvert(format: ImportFormat): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		let totalConverted = 0;
		let filesTouched = 0;
		for (const f of files) {
			const content = await this.app.vault.read(f);
			const result = convertAllComments(content, format, "uncategorized");
			if (result.converted === 0) continue;
			await this.app.vault.modify(f, result.updated);
			this.commentIndex.rebuild(f.path, result.updated);
			totalConverted += result.converted;
			filesTouched += 1;
		}
		this.events.emit("index-changed");
		new Notice(`Converted ${totalConverted} comment(s) across ${filesTouched} file(s).`);
	}

	private async writeDiagnosticsReport(label: string, findings: unknown[]): Promise<void> {
		// Write findings to a vault note so the user can read them without
		// opening devtools. V2 adds debug-log routing per F-237.
		const filename = `Annoteca diagnostics — ${label}.md`;
		const lines: string[] = [];
		lines.push(`# ${label}`);
		lines.push("");
		lines.push(`Generated: ${todayISO()}`);
		lines.push("");
		lines.push("```json");
		lines.push(JSON.stringify(findings, null, 2));
		lines.push("```");
		const body = lines.join("\n");

		const existing = this.app.vault.getAbstractFileByPath(filename);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, body);
		} else {
			await this.app.vault.create(filename, body);
		}
	}

	// Helpers used by commands -----------------------------------------

	private withCommentAtCursor(
		editor: Editor,
		view: MarkdownView,
		handler: (path: string, c: Comment) => void,
	): void {
		const file = view.file;
		if (!file) return;
		const offset = editor.posToOffset(editor.getCursor());
		const idx = this.commentIndex.get(file.path);
		if (!idx) {
			new Notice("Index not ready.");
			return;
		}
		const found = idx.comments.find(c => offset >= c.marker.start && offset <= c.marker.end);
		if (!found) {
			new Notice("No comment here.");
			return;
		}
		handler(file.path, found);
	}

	private async activateView(type: string, placement: "right" | "tab"): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(type);
		if (leaves.length > 0 && leaves[0]) {
			this.app.workspace.setActiveLeaf(leaves[0]);
			return;
		}
		let leaf: WorkspaceLeaf | null;
		if (placement === "right") {
			leaf = this.app.workspace.getRightLeaf(false);
		} else {
			leaf = this.app.workspace.getLeaf("tab");
		}
		if (leaf) await leaf.setViewState({ type, active: true });
	}
}
