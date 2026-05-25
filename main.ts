import {
	Editor,
	Events,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TFile,
	type WorkspaceLeaf,
} from "obsidian";

import type { AnnotecaSettings, Comment, Reply } from "./types";
import { CommentIndex } from "./index";
import { DEFAULT_SETTINGS, AnnotecaSettingTab } from "./settings";
import { AddCommentModal } from "./modal";
import {
	buildAnnotecaExtension,
	setHideAllComments,
} from "./decorations";
import {
	PER_FILE_VIEW_TYPE,
	PerFileSidebarView,
	VAULT_UNRESOLVED_VIEW_TYPE,
	VaultUnresolvedView,
	REVIEWER_PANE_VIEW_TYPE,
	ReviewerPaneView,
	OUTLINE_DENSITY_VIEW_TYPE,
	OutlineDensityView,
	INDEX_VIEW_TYPE,
	IndexEntryView,
	COMPOSER_PANEL_VIEW_TYPE,
	ComposerPanelView,
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
	private reviewerPanePinned = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerEditorExtension(buildAnnotecaExtension({
			getSettings: () => this.settings,
			onMarkerClick: (m) => this.openReviewerOnComment(m),
		}));

		this.registerView(PER_FILE_VIEW_TYPE, leaf => new PerFileSidebarView(leaf, this));
		this.registerView(VAULT_UNRESOLVED_VIEW_TYPE, leaf => new VaultUnresolvedView(leaf, this));
		this.registerView(REVIEWER_PANE_VIEW_TYPE, leaf => new ReviewerPaneView(leaf, this));
		this.registerView(OUTLINE_DENSITY_VIEW_TYPE, leaf => new OutlineDensityView(leaf, this));
		this.registerView(INDEX_VIEW_TYPE, leaf => new IndexEntryView(leaf, this));
		this.registerView(COMPOSER_PANEL_VIEW_TYPE, leaf => new ComposerPanelView(leaf, this));

		this.addSettingTab(new AnnotecaSettingTab(this.app, this));

		this.registerCommands();
		this.registerFileEvents();
		this.registerEditorMenu();

		this.addRibbonIcon("message-square", "Annoteca: open comments pane", () => {
			void this.activateView(REVIEWER_PANE_VIEW_TYPE, "right");
		});

		this.app.workspace.onLayoutReady(() => {
			this.refreshActiveFileIndex();
			this.ensureRightSidebarTab();
		});
	}

	private ensureRightSidebarTab(): void {
		// Place the reviewer pane in the right sidebar on first load so its
		// tab icon shows up alongside backlinks, tags, and the other native
		// right-pane tools. If a user has explicitly closed it, this won't
		// reopen on subsequent loads because the leaf record persists across
		// sessions and we only add when none exists.
		const existing = this.app.workspace.getLeavesOfType(REVIEWER_PANE_VIEW_TYPE);
		if (existing.length > 0) return;
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		void leaf.setViewState({ type: REVIEWER_PANE_VIEW_TYPE, active: false });
	}

	onunload(): void {
		// Obsidian disposes registered commands, views, events, and editor
		// extensions automatically. Nothing custom to clean up.
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<AnnotecaSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
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
			editorCallback: (editor: Editor, view: MarkdownView) => this.jumpToAdjacentComment(editor, view, "next", false),
		});
		this.addCommand({
			id: "previous-comment",
			name: "Previous comment",
			editorCallback: (editor: Editor, view: MarkdownView) => this.jumpToAdjacentComment(editor, view, "previous", false),
		});
		this.addCommand({
			id: "next-unresolved-comment",
			name: "Next unresolved comment",
			editorCallback: (editor: Editor, view: MarkdownView) => this.jumpToAdjacentComment(editor, view, "next", true),
		});
		this.addCommand({
			id: "previous-unresolved-comment",
			name: "Previous unresolved comment",
			editorCallback: (editor: Editor, view: MarkdownView) => this.jumpToAdjacentComment(editor, view, "previous", true),
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
			id: "open-per-file-sidebar",
			name: "Open file comments pane",
			callback: () => { void this.activateView(PER_FILE_VIEW_TYPE, "right"); },
		});
		this.addCommand({
			id: "open-vault-unresolved-view",
			name: "Open unresolved comments view",
			callback: () => { void this.activateView(VAULT_UNRESOLVED_VIEW_TYPE, "tab"); },
		});
		this.addCommand({
			id: "open-reviewer-pane",
			name: "Open reviewer pane",
			callback: () => { void this.activateView(REVIEWER_PANE_VIEW_TYPE, "right"); },
		});
		this.addCommand({
			id: "open-outline-density-view",
			name: "Open comment density outline",
			callback: () => { void this.activateView(OUTLINE_DENSITY_VIEW_TYPE, "right"); },
		});
		this.addCommand({
			id: "open-index-view",
			name: "Open index entries view",
			callback: () => { void this.activateView(INDEX_VIEW_TYPE, "tab"); },
		});
		this.addCommand({
			id: "toggle-reviewer-pin",
			name: "Pin or unpin the reviewer pane",
			callback: () => this.toggleReviewerPin(),
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
		await this.activateView(REVIEWER_PANE_VIEW_TYPE, "right");
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

	async copyCommentId(comment: Comment): Promise<void> {
		if (!comment.id) {
			new Notice("This comment has no ID.");
			return;
		}
		await navigator.clipboard.writeText(comment.id);
		new Notice(`Copied ID ${comment.id}.`);
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
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			const pos = view.editor.offsetToPos(offset);
			view.editor.setCursor(pos);
			view.editor.scrollIntoView({ from: pos, to: pos }, true);
		}
	}

	private jumpToAdjacentComment(
		editor: Editor,
		view: MarkdownView,
		direction: "next" | "previous",
		unresolvedOnly: boolean,
	): void {
		const file = view.file;
		if (!file) return;
		const idx = this.commentIndex.get(file.path);
		if (!idx || idx.comments.length === 0) {
			new Notice("No comments in this file.");
			return;
		}
		const cursorOffset = editor.posToOffset(editor.getCursor());
		const eligible = idx.comments.filter(c => !unresolvedOnly || !c.resolution);
		if (eligible.length === 0) {
			new Notice("No matching comments.");
			return;
		}
		const sorted = [...eligible].sort((a, b) => a.marker.start - b.marker.start);
		let target: Comment | undefined;
		if (direction === "next") {
			target = sorted.find(c => c.marker.start > cursorOffset) ?? sorted[0];
		} else {
			for (let i = sorted.length - 1; i >= 0; i--) {
				const candidate = sorted[i];
				if (candidate && candidate.marker.start < cursorOffset) {
					target = candidate;
					break;
				}
			}
			target = target ?? sorted[sorted.length - 1];
		}
		if (!target) return;
		const pos = editor.offsetToPos(target.marker.start);
		editor.setCursor(pos);
		editor.scrollIntoView({ from: pos, to: pos }, true);
		this.openReviewerOnComment(target, file.path);
	}

	// Reviewer pane wiring ----------------------------------------------

	openReviewerOnComment(comment: Comment, path?: string): void {
		const filePath = path ?? this.app.workspace.getActiveFile()?.path;
		if (!filePath) return;
		this.events.emit("active-comment-changed", { path: filePath, start: comment.marker.start });
		void this.activateView(REVIEWER_PANE_VIEW_TYPE, "right");
	}

	private toggleReviewerPin(): void {
		const leaves = this.app.workspace.getLeavesOfType(REVIEWER_PANE_VIEW_TYPE);
		if (leaves.length === 0) return;
		const leaf = leaves[0];
		if (!leaf) return;
		const view = leaf.view as unknown as ReviewerPaneView;
		const pinned = view.togglePinned();
		this.reviewerPanePinned = pinned;
		new Notice(pinned ? "Reviewer pane pinned." : "Reviewer pane unpinned.");
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
		const order: AnnotecaSettings["indicatorStyle"][] = ["both", "gutter", "inline", "none"];
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
