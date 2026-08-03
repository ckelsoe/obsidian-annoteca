import {
	Editor,
	Events,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TFile,
	getAllTags,
	normalizePath,
	type WorkspaceLeaf,
} from 'obsidian';

import type {
	AnnotecaSettings,
	Comment,
	Reply,
	ScopeShape,
	ScopeState,
	StatusFilter,
} from './types';
import { CommentIndex } from './index';
import {
	DEFAULT_SETTINGS,
	AnnotecaSettingTab,
	resolveSettingsCategories,
} from './settings';
import { getCategoryOrFallback } from './categories';
import {
	buildSkillMarkdown,
	skillTargetPaths,
	parseSkillVersion,
	SKILL_SCHEMA_VERSION,
	type SkillStatus,
} from './skill-export';
import { registerReadingViewIndicator } from './reading-view';
import { AddCommentModal } from './modal';
import {
	buildAnnotecaExtension,
	setHideAllCommentsEverywhere,
	isHideAllComments,
	setShowCommentBodiesEverywhere,
	isShowingCommentBodies,
	inlineBodiesBlockedBy,
	refreshDecorationsEverywhere,
	setActiveComment,
} from './decorations';
import {
	decideScrollAction,
	authorColorFor,
	authorPickerOptions,
	resolveMarkerClickAction,
	type ScrollAction,
} from './view-utils';
import { isMobile } from './platform';
import { EditorView } from '@codemirror/view';

// Top margin (px) left above the marker when anchoring it near the top of the
// editor pane (markerScrollAlign === "top"). A little breathing room reads
// better than flush against the very first visible line.
const TOP_SCROLL_MARGIN_PX = 60;
import {
	VAULT_UNRESOLVED_VIEW_TYPE,
	VaultUnresolvedView,
	INDEX_VIEW_TYPE,
	IndexEntryView,
	COMPOSER_PANEL_VIEW_TYPE,
	ComposerPanelView,
	ANNOTECA_HUB_VIEW_TYPE,
	AnnotecaPanelView,
} from './views';
import type { ComposerRequest } from './composer';
import { todayISO } from './parser';
import { convertAllComments, type ImportFormat } from './imports';
import {
	ConfirmBackupModal,
	ConfirmDeleteCommentModal,
	ConfirmDeleteResolvedModal,
} from './confirm-modal';
import { formatScripture } from './scripture';
import { computeScopeFileSet, type ScopeFile } from './scope';
import { CommentService } from './comment-service';
import { DiagnosticsService } from './diagnostics-service';

export default class AnnotecaPlugin extends Plugin {
	settings!: AnnotecaSettings;
	commentIndex = new CommentIndex();
	events = new Events();
	comments!: CommentService;
	diagnostics!: DiagnosticsService;
	private vaultScanned = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.comments = new CommentService(this);
		this.diagnostics = new DiagnosticsService(this);

		this.registerEditorExtension(
			buildAnnotecaExtension({
				app: this.app,
				// The note the popover's comment lives in, for resolving
				// relative links and wikilinks in a rendered body. The editor
				// extension is per-leaf but the context is built once, so this
				// reads the active file at render time rather than capturing it.
				getSourcePath: () =>
					this.app.workspace.getActiveFile()?.path ?? '',
				getSettings: () => this.settings,
				onMarkerClick: (m) => this.openReviewerOnComment(m),
				openInReviewer: (m) => this.openReviewerOnComment(m),
				addCommentForSelection: () => {
					const view =
						this.app.workspace.getActiveViewOfType(MarkdownView);
					if (view) this.openModalForSelection(view.editor);
				},
				categoryFor: (id) =>
					getCategoryOrFallback(
						id,
						resolveSettingsCategories(this.settings),
					),
				toggleResolution: (m) => {
					void this.toggleResolutionFromPopup(m);
				},
				resolveAndRemove: (m) => {
					void this.resolveAndRemoveFromPopup(m);
				},
				acceptAddressed: (m) => {
					void this.acceptAddressedFromPopup(m);
				},
				reviseAddressed: (m) => {
					void this.reviseAddressedFromPopup(m);
				},
				rejectAddressed: (m) => {
					void this.rejectAddressedFromPopup(m);
				},
				copyPermalink: (m) => {
					void this.copyCommentId(m);
				},
				submitReply: (m, body, author, sourcePath) =>
					this.submitReplyFromPopup(m, body, author, sourcePath),
				getAuthorTag: () => this.comments.resolvedAuthor(),
				getAuthorOptions: () => this.authorPickerOptions([]),
				authorColor: (tag) => this.authorColor(tag),
				isStarred: (m) => this.isStarred(m),
				toggleStarred: (m) => {
					void this.toggleStarred(m);
				},
				loadDraft: (id) => this.loadDraft(id),
				saveDraft: (id, body) => this.saveDraft(id, body),
				clearDraft: (id) => this.clearDraft(id),
			}),
		);

		this.registerView(
			ANNOTECA_HUB_VIEW_TYPE,
			(leaf) => new AnnotecaPanelView(leaf, this),
		);
		this.registerView(
			VAULT_UNRESOLVED_VIEW_TYPE,
			(leaf) => new VaultUnresolvedView(leaf, this),
		);
		this.registerView(
			INDEX_VIEW_TYPE,
			(leaf) => new IndexEntryView(leaf, this),
		);
		this.registerView(
			COMPOSER_PANEL_VIEW_TYPE,
			(leaf) => new ComposerPanelView(leaf, this),
		);

		this.addSettingTab(new AnnotecaSettingTab(this.app, this));

		this.registerCommands();
		this.registerFileEvents();
		this.registerEditorMenu();
		registerReadingViewIndicator(this);

		this.addRibbonIcon(
			'message-square',
			'Annoteca: open comments pane',
			() => {
				void this.activateView(ANNOTECA_HUB_VIEW_TYPE, 'right');
			},
		);

		this.applyIndicatorSize();
		this.applyAnchorAppearance();

		this.app.workspace.onLayoutReady(() => {
			this.refreshActiveFileIndex();
			this.ensureRightSidebarTab();
			void this.checkSkillStaleness();
		});
	}

	// Apply the indicator-size setting to a body-level CSS variable so the
	// marker styling in styles.css can scale dynamically without recreating
	// the editor extension. Called on load and on settings change.
	applyIndicatorSize(): void {
		const sizes: Record<AnnotecaSettings['indicatorSize'], string> = {
			small: '0.85em',
			medium: '1em',
			large: '1.25em',
		};
		activeDocument.body.style.setProperty(
			'--annoteca-indicator-size',
			sizes[this.settings.indicatorSize],
		);
	}

	// Apply the anchor-underline style + baseline thickness + resolved
	// brightness to body-level CSS variables. styles.css consumes them for
	// the .annoteca-anchor rule, the per-tier overrides, and the .annoteca-
	// resolved opacity. Called on load and on settings change.
	applyAnchorAppearance(): void {
		const thicknesses: Record<AnnotecaSettings['anchorThickness'], string> =
			{
				thin: '1px',
				medium: '2px',
				thick: '3px',
			};
		const resolvedOpacities: Record<
			AnnotecaSettings['resolvedBrightness'],
			string
		> = {
			normal: '0.5',
			bright: '0.85',
		};
		activeDocument.body.style.setProperty(
			'--annoteca-anchor-style',
			this.settings.anchorStyle,
		);
		activeDocument.body.style.setProperty(
			'--annoteca-anchor-thickness-normal',
			thicknesses[this.settings.anchorThickness],
		);
		activeDocument.body.style.setProperty(
			'--annoteca-resolved-opacity',
			resolvedOpacities[this.settings.resolvedBrightness],
		);
	}

	private ensureRightSidebarTab(): void {
		// Place the reviewer pane in the right sidebar on first load so its
		// tab icon shows up alongside backlinks, tags, and the other native
		// right-pane tools. If a user has explicitly closed it, this won't
		// reopen on subsequent loads because the leaf record persists across
		// sessions and we only add when none exists.
		const existing = this.app.workspace.getLeavesOfType(
			ANNOTECA_HUB_VIEW_TYPE,
		);
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
		const loaded =
			(await this.loadData()) as Partial<AnnotecaSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(loaded ?? {}),
			indicatorStyle: DEFAULT_SETTINGS.indicatorStyle,
			// Resolved from the RAW loaded value, not from the spread above, so
			// that "absent" is distinguishable from "explicitly set to panel".
			// The spread has already filled in the DEFAULT_SETTINGS placeholder
			// by this point, which would make every existing desktop install
			// look like a deliberate choice and every new mobile install too.
			markerClickAction: resolveMarkerClickAction(
				loaded?.markerClickAction,
				isMobile(),
			),
			// data.json is user-editable and also arrives over sync, so a stored
			// value is not guaranteed to be the type it was written as. The
			// spread would take a string "false" verbatim, and every read of
			// this setting is a truthiness test, so a disabled setting would
			// come back on. Fall back to the default for anything non-boolean.
			renderMarkdownBodies:
				typeof loaded?.renderMarkdownBodies === 'boolean'
					? loaded.renderMarkdownBodies
					: DEFAULT_SETTINGS.renderMarkdownBodies,
		};

		// Migrate legacy indicatorStyle values. Prior to the underline rewrite,
		// "gutter" meant the (misplaced) left-margin dot and "inline" meant the
		// in-prose ◆ widget. New names are "icon" and "underline" respectively.
		// Use unknown-string compares so TypeScript doesn't narrow the union.
		const legacy = loaded?.indicatorStyle as string | undefined;
		if (legacy === 'gutter') this.settings.indicatorStyle = 'icon';
		else if (legacy === 'inline')
			this.settings.indicatorStyle = 'underline';
		else if (
			legacy === 'icon' ||
			legacy === 'underline' ||
			legacy === 'both' ||
			legacy === 'none'
		) {
			this.settings.indicatorStyle = legacy;
		}

		if (
			!this.settings.categories ||
			this.settings.categories.length === 0
		) {
			this.settings.categories = [...DEFAULT_SETTINGS.categories];
		}

		// Migrate the legacy centerCommentOnNavigate boolean to markerScrollAlign
		// (F-289). Only an explicit opt-in to centering (true) carries over as
		// "center"; everyone else adopts the new "top" default, which is the
		// improved reading anchor. "Minimal" (the old don't-yank behavior) stays
		// available in the dropdown for anyone who wants it back.
		const legacyCenter = (
			loaded as { centerCommentOnNavigate?: unknown } | null
		)?.centerCommentOnNavigate;
		if (
			loaded &&
			!('markerScrollAlign' in loaded) &&
			legacyCenter === true
		) {
			this.settings.markerScrollAlign = 'center';
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Editor decorations read settings through a closure CodeMirror cannot
		// watch, so a saved change has to be announced or every open editor
		// keeps drawing the old one until the next click or keystroke.
		refreshDecorationsEverywhere();
		this.events.trigger('settings-changed');
	}

	private registerFileEvents(): void {
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					void this.rebuildIndexForFile(file);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile) {
					this.commentIndex.rename(oldPath, file.path);
					this.events.trigger('index-changed');
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) {
					this.commentIndex.remove(file.path);
					this.events.trigger('index-changed');
				}
			}),
		);
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file && file.extension === 'md') {
					void this.rebuildIndexForFile(file);
					this.onActiveFileChangedForScope(file);
				}
			}),
		);
	}

	private registerEditorMenu(): void {
		this.registerEvent(
			this.app.workspace.on(
				'editor-menu',
				(menu: Menu, editor: Editor, view: MarkdownView) => {
					menu.addSeparator();
					if (editor.getSelection().length > 0) {
						menu.addItem((item) =>
							item
								.setTitle('Annoteca: add comment for selection')
								.setIcon('message-square-plus')
								.onClick(() =>
									this.openModalForSelection(editor),
								),
						);
					} else {
						menu.addItem((item) =>
							item
								.setTitle('Annoteca: add comment here')
								.setIcon('message-square-plus')
								.onClick(() => this.openModalAtCursor(editor)),
						);
					}

					const file = view.file;
					if (!file) return;
					const idx = this.commentIndex.get(file.path);
					if (!idx) return;
					const cursorOffset = editor.posToOffset(editor.getCursor());
					const inside = idx.comments.find(
						(c) =>
							cursorOffset >= c.marker.start &&
							cursorOffset <= c.marker.end,
					);
					if (!inside) return;

					menu.addItem((item) =>
						item
							.setTitle('Annoteca: edit comment')
							.setIcon('pencil')
							.onClick(() =>
								this.openEditModal(editor, file.path, inside),
							),
					);
					if (inside.resolution) {
						menu.addItem((item) =>
							item
								.setTitle('Annoteca: reopen comment')
								.setIcon('rotate-ccw')
								.onClick(() => {
									void this.reopenComment(file.path, inside);
								}),
						);
					} else {
						menu.addItem((item) =>
							item
								.setTitle('Annoteca: resolve comment')
								.setIcon('check')
								.onClick(() => {
									void this.resolveComment(file.path, inside);
								}),
						);
						menu.addItem((item) =>
							item
								.setTitle(
									'Annoteca: resolve and remove comment',
								)
								.setIcon('check-check')
								.onClick(() => {
									void this.resolveAndRemoveComment(
										file.path,
										inside,
									);
								}),
						);
					}
					menu.addItem((item) =>
						item
							.setTitle('Annoteca: reply to comment')
							.setIcon('reply')
							.onClick(() =>
								this.openReviewerOnComment(inside, file.path),
							),
					);
					menu.addItem((item) =>
						item
							.setTitle('Annoteca: delete comment')
							.setIcon('trash')
							.onClick(() => {
								void this.deleteComment(file.path, inside);
							}),
					);
				},
			),
		);
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'add-comment-at-cursor',
			name: 'Add comment here',
			editorCallback: (editor: Editor) => this.openModalAtCursor(editor),
		});
		this.addCommand({
			id: 'add-comment-for-selection',
			name: 'Add comment for selection',
			editorCallback: (editor: Editor) =>
				this.openModalForSelection(editor),
		});
		this.addCommand({
			id: 'add-scratchpad-comment',
			name: 'Add scratchpad comment',
			editorCallback: (editor: Editor) =>
				this.openScratchpadModal(editor),
		});
		this.addCommand({
			id: 'edit-comment-at-cursor',
			name: 'Edit comment here',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withCommentAtCursor(editor, view, (path, c) =>
					this.openEditModal(editor, path, c),
				);
			},
		});
		this.addCommand({
			id: 'delete-comment-at-cursor',
			name: 'Delete comment here',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withCommentAtCursor(editor, view, (path, c) => {
					void this.deleteComment(path, c);
				});
			},
		});
		this.addCommand({
			id: 'resolve-comment-at-cursor',
			name: 'Resolve comment here',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withCommentAtCursor(editor, view, (path, c) => {
					void this.resolveComment(path, c);
				});
			},
		});
		this.addCommand({
			id: 'resolve-and-remove-comment-at-cursor',
			name: 'Resolve and remove comment here',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withCommentAtCursor(editor, view, (path, c) => {
					void this.resolveAndRemoveComment(path, c);
				});
			},
		});
		// F-270 addressed-state actions. The pointer-free counterpart to the
		// hover popup and the panel buttons: a hotkey works with no pointer at
		// all, which is the only route that exists on touch once hover is gone.
		this.addCommand({
			id: 'accept-addressed-at-cursor',
			name: 'Accept addressed edit here',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withAddressedCommentAtCursor(editor, view, (path, c) => {
					void this.acceptAddressedFromPanel(path, c);
				});
			},
		});
		this.addCommand({
			id: 'revise-addressed-at-cursor',
			name: 'Revise addressed edit here',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withAddressedCommentAtCursor(editor, view, (path, c) => {
					void this.reviseAddressedFromPanel(path, c);
				});
			},
		});
		this.addCommand({
			id: 'reject-addressed-at-cursor',
			name: 'Reject addressed edit here',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withAddressedCommentAtCursor(editor, view, (path, c) => {
					void this.rejectAddressedFromPanel(path, c);
				});
			},
		});
		this.addCommand({
			id: 'delete-all-resolved-in-file',
			name: 'Delete all resolved comments in this file',
			editorCallback: (_editor: Editor, view: MarkdownView) => {
				const file = view.file;
				if (!file) return;
				void (async () => {
					const resolved = await this.listResolvedInFile(file.path);
					if (resolved.length === 0) {
						new Notice('No resolved comments in this file.');
						return;
					}
					new ConfirmDeleteResolvedModal(
						this.app,
						resolved.length,
						file.basename,
						() => {
							void (async () => {
								const removed =
									await this.deleteAllResolvedInFile(
										file.path,
									);
								// null means the file could not be opened and
								// the service has already said so. Reporting a
								// count here would claim a deletion that did
								// not happen.
								if (removed === null) return;
								const noun =
									removed === 1 ? 'comment' : 'comments';
								new Notice(
									`Deleted ${removed} resolved ${noun}.`,
								);
							})();
						},
					).open();
				})();
			},
		});
		this.addCommand({
			id: 'reopen-comment-at-cursor',
			name: 'Reopen resolved comment here',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withCommentAtCursor(editor, view, (path, c) => {
					void this.reopenComment(path, c);
				});
			},
		});
		this.addCommand({
			id: 'reply-to-comment-at-cursor',
			name: 'Reply to comment here',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.withCommentAtCursor(editor, view, (path, c) =>
					this.openReviewerOnComment(c, path),
				);
			},
		});
		this.addCommand({
			id: 'next-comment',
			name: 'Next comment',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				void this.jumpToAdjacentComment(editor, view, 'next', false);
			},
		});
		this.addCommand({
			id: 'previous-comment',
			name: 'Previous comment',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				void this.jumpToAdjacentComment(
					editor,
					view,
					'previous',
					false,
				);
			},
		});
		this.addCommand({
			id: 'next-unresolved-comment',
			name: 'Next unresolved comment',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				void this.jumpToAdjacentComment(editor, view, 'next', true);
			},
		});
		this.addCommand({
			id: 'previous-unresolved-comment',
			name: 'Previous unresolved comment',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				void this.jumpToAdjacentComment(editor, view, 'previous', true);
			},
		});
		this.addCommand({
			id: 'toggle-hide-all-comments',
			name: 'Toggle hide-all-comments mode',
			editorCallback: (editor: Editor) => {
				// Do nothing when the invoking editor has no CodeMirror view,
				// matching the previous behaviour: there is nothing to toggle
				// from a surface the extension was never installed into. The
				// toggle itself is not scoped to this editor, it reaches every
				// registered one.
				if (!editor.cm) return;
				const currentlyHidden = this.toggleHideAll();
				new Notice(
					currentlyHidden ? 'Comments hidden.' : 'Comments visible.',
				);
			},
		});
		this.addCommand({
			id: 'toggle-inline-comment-bodies',
			name: 'Toggle inline comment bodies',
			editorCallback: (editor: Editor) => {
				// Same guard as hide-all: nothing to toggle from a surface the
				// extension was never installed into.
				if (!editor.cm) return;
				// Refuse to turn bodies ON when nothing would appear, and say
				// which switch is in the way. Flipping a flag nothing draws
				// would be worse than a no-op: the press looks broken, and the
				// NEXT press is then the one that appears to do nothing.
				//
				// Turning bodies OFF is always allowed, whatever is blocking
				// them. Refusing there would strand the flag on where nothing
				// is drawn to reveal it is still set, so the bodies would
				// spring back the moment the block cleared.
				const blocker = inlineBodiesBlockedBy(this.settings);
				if (blocker !== null && !isShowingCommentBodies()) {
					new Notice(
						blocker === 'hide-all'
							? 'Comments are hidden. Turn off hide-all-comments mode to show comment bodies.'
							: 'Inline comment bodies need the marker icon. Change the indicator style setting to show icons.',
					);
					return;
				}
				const showing = this.toggleShowCommentBodies();
				new Notice(
					showing
						? 'Comment bodies shown inline.'
						: 'Comment bodies hidden.',
				);
			},
		});
		this.addCommand({
			id: 'cycle-indicator-style',
			name: 'Cycle indicator style',
			callback: () => {
				void this.cycleIndicatorStyle();
			},
		});
		this.addCommand({
			id: 'open-hub',
			name: 'Open comments panel',
			callback: () => {
				void this.activateView(ANNOTECA_HUB_VIEW_TYPE, 'right');
			},
		});
		this.addCommand({
			id: 'open-vault-unresolved-view',
			name: 'Open unresolved comments view',
			callback: () => {
				void this.activateView(VAULT_UNRESOLVED_VIEW_TYPE, 'tab');
			},
		});
		this.addCommand({
			id: 'open-index-view',
			name: 'Open index entries view',
			callback: () => {
				void this.activateView(INDEX_VIEW_TYPE, 'tab');
			},
		});
		this.addCommand({
			id: 'check-marker-conflicts',
			name: 'Check for marker conflicts',
			callback: () => {
				this.runGuarded('Conflict check', () =>
					this.diagnostics.runConflictCheck(),
				);
			},
		});
		this.addCommand({
			id: 'detect-orphan-comments',
			name: 'Detect orphan comments',
			callback: () => {
				this.runGuarded('Orphan check', () =>
					this.diagnostics.runOrphanCheck(),
				);
			},
		});
		this.addCommand({
			id: 'validate-marker-format',
			name: 'Validate marker format',
			callback: () => {
				this.runGuarded('Marker validation', () =>
					this.diagnostics.runMarkerValidation(),
				);
			},
		});
		this.addCommand({
			id: 'format-scripture-references',
			name: 'Format scripture references in current file',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const file = view.file;
				if (!file) return;
				const text = editor.getValue();
				const r = formatScripture(text);
				if (r.changes === 0) {
					new Notice('No scripture references to format.');
					return;
				}
				editor.setValue(r.updated);
				new Notice(`Formatted ${r.changes} reference(s).`);
			},
		});
		this.addCommand({
			id: 'export-ai-skill',
			name: 'Export AI skill',
			callback: () => {
				this.exportAiSkill();
			},
		});
		this.addCommand({
			id: 'backup-settings',
			name: 'Back up settings',
			callback: () => {
				this.runGuarded('Settings backup', () => this.backupSettings());
			},
		});
		this.addCommand({
			id: 'restore-settings',
			name: 'Restore settings from backup',
			callback: () => {
				this.runGuarded('Settings restore', () =>
					this.restoreSettings(),
				);
			},
		});
		this.addCommand({
			id: 'self-diagnostic',
			name: 'Run self-diagnostic',
			callback: () => {
				this.runGuarded('Self-diagnostic', () =>
					this.diagnostics.runSelfDiagnostic(),
				);
			},
		});
		this.addCommand({
			id: 'detect-position-drift',
			name: 'Detect position drift',
			callback: () => {
				this.runGuarded('Drift check', () =>
					this.diagnostics.runDriftCheck(),
				);
			},
		});
		this.addCommand({
			id: 'import-native-comments',
			name: 'Import native Obsidian comments',
			callback: () => this.confirmAndConvert('native'),
		});
		this.addCommand({
			id: 'import-html-comments',
			name: 'Import generic HTML comments',
			callback: () => this.confirmAndConvert('html'),
		});
		this.addCommand({
			id: 'import-all-comments',
			name: 'Convert every comment to the canonical format',
			callback: () => this.confirmAndConvert('all'),
		});
	}

	// File / index helpers ------------------------------------------------

	private async rebuildIndexForFile(file: TFile): Promise<void> {
		const content = await this.app.vault.cachedRead(file);
		this.commentIndex.rebuild(file.path, content);
		this.events.trigger('index-changed', { path: file.path });
	}

	async scanVaultIfNeeded(): Promise<void> {
		if (this.vaultScanned) return;
		const files = this.app.vault.getMarkdownFiles();
		for (const f of files) {
			const content = await this.app.vault.cachedRead(f);
			this.commentIndex.rebuild(f.path, content);
		}
		this.vaultScanned = true;
		this.events.trigger('index-changed');
	}

	private refreshActiveFileIndex(): void {
		const active = this.app.workspace.getActiveFile();
		if (active && active.extension === 'md') {
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

	private openEditModal(
		editor: Editor,
		path: string,
		comment: Comment,
	): void {
		const from = editor.offsetToPos(comment.marker.start);
		const to = editor.offsetToPos(comment.marker.end);
		this.openComposer({
			editor,
			filePath: path,
			editing: { comment, from, to },
		});
	}

	private openComposer(request: ComposerRequest): void {
		if (this.settings.composerLocation === 'panel') {
			void this.openComposerPanel(request);
		} else {
			new AddCommentModal(this.app, this, request).open();
		}
	}

	private async openComposerPanel(request: ComposerRequest): Promise<void> {
		await this.activateView(COMPOSER_PANEL_VIEW_TYPE, 'right');
		const leaves = this.app.workspace.getLeavesOfType(
			COMPOSER_PANEL_VIEW_TYPE,
		);
		const view = leaves[0]?.view;
		if (view instanceof ComposerPanelView) view.setRequest(request);
	}

	async notifyComposerSubmitted(
		path: string,
		markerStart: number,
	): Promise<void> {
		// Snapshot the current editor text and rebuild the index so the new
		// (or edited) marker is queryable before the vault.modify event lands.
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			const content =
				view?.editor.getValue() ??
				(await this.app.vault.cachedRead(file));
			this.commentIndex.rebuild(path, content);
		}
		this.events.trigger('index-changed', { path });
		this.events.trigger('active-comment-changed', {
			path,
			start: markerStart,
		});
		await this.activateView(ANNOTECA_HUB_VIEW_TYPE, 'right');
	}

	// Comment lifecycle operations ---------------------------------------

	// Public lifecycle verbs are thin pass-throughs to CommentService. The
	// service owns the actual marker read/serialize/write + index rebuild
	// + event emission. Keeping the plugin facade stable so external callers
	// (hub Thread tab, popup handlers) do not need to know about the split.

	async resolveComment(path: string, comment: Comment): Promise<void> {
		await this.comments.resolveComment(path, comment);
	}

	async reopenComment(path: string, comment: Comment): Promise<void> {
		await this.comments.reopenComment(path, comment);
	}

	async deleteComment(path: string, comment: Comment): Promise<void> {
		// All single-comment delete entry points (Thread tab action button,
		// editor right-click menu, command palette) flow through this method,
		// so the confirmation gate lives here in one place rather than at
		// every call site. The bulk delete-all-resolved path has its own
		// modal and is not affected.
		return new Promise<void>((resolve) => {
			new ConfirmDeleteCommentModal(
				this.app,
				this.settings,
				comment,
				() => {
					void this.comments
						.deleteComment(path, comment)
						.then(resolve);
				},
			).open();
		});
	}

	async resolveAndRemoveComment(
		path: string,
		comment: Comment,
	): Promise<void> {
		// Explicit destructive action: always confirms, mirroring deleteComment.
		// (When the delete-on-resolve setting is on, plain resolveComment removes
		// without asking; that path does not come through here.)
		return new Promise<void>((resolve) => {
			new ConfirmDeleteCommentModal(
				this.app,
				this.settings,
				comment,
				() => {
					// No freshness guard: this is the explicit destructive
					// action, already confirmed by the modal above, so it acts
					// on whatever is currently at the marker.
					void this.comments
						.resolveAndRemoveComment(path, comment)
						.then(() => resolve());
				},
				{
					title: 'Resolve and remove comment',
					cta: 'Resolve and remove',
				},
			).open();
		});
	}

	async listResolvedInFile(path: string): Promise<Comment[]> {
		return this.comments.listResolvedInFile(path);
	}

	async deleteAllResolvedInFile(path: string): Promise<number | null> {
		return this.comments.deleteAllResolvedInFile(path);
	}

	async appendReply(
		path: string,
		comment: Comment,
		reply: Reply,
	): Promise<boolean> {
		return this.comments.appendReply(path, comment, reply);
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

	async resolveAndRemoveFromPopup(comment: Comment): Promise<void> {
		const path = this.app.workspace.getActiveFile()?.path;
		if (!path) return;
		await this.resolveAndRemoveComment(path, comment);
	}

	// F-270 addressed-state actions from the hover popup.
	async acceptAddressedFromPopup(comment: Comment): Promise<void> {
		const path = this.app.workspace.getActiveFile()?.path;
		if (!path) return;
		await this.comments.acceptAddressed(path, comment);
	}

	async reviseAddressedFromPopup(comment: Comment): Promise<void> {
		const path = this.app.workspace.getActiveFile()?.path;
		if (!path) return;
		await this.comments.reviseAddressed(path, comment);
	}

	async rejectAddressedFromPopup(comment: Comment): Promise<void> {
		const path = this.app.workspace.getActiveFile()?.path;
		if (!path) return;
		await this.comments.rejectAddressed(path, comment);
	}

	// F-270 addressed-state actions from the Hub panel and from commands. These
	// take the path explicitly rather than reading the active file, because the
	// panel can list comments from files that are not open: deriving the path
	// from the workspace would apply the action to the wrong document.
	async acceptAddressedFromPanel(
		path: string,
		comment: Comment,
	): Promise<void> {
		await this.comments.acceptAddressed(path, comment);
	}

	async reviseAddressedFromPanel(
		path: string,
		comment: Comment,
	): Promise<void> {
		await this.comments.reviseAddressed(path, comment);
	}

	async rejectAddressedFromPanel(
		path: string,
		comment: Comment,
	): Promise<void> {
		await this.comments.rejectAddressed(path, comment);
	}

	// Returns whether the reply was written, so the popup composer knows not to
	// clear the draft and close when the write was refused.
	async submitReplyFromPopup(
		comment: Comment,
		body: string,
		author: string | undefined,
		// The file the popover's own editor holds. Falls back to the active file
		// only when the editor cannot say, which is the same rule the popover
		// uses to resolve links in a rendered body.
		sourcePath?: string,
	): Promise<boolean> {
		const trimmed = body.trim();
		if (trimmed.length === 0) return false;
		const tag = (author ?? '').trim();
		const reply: Reply = {
			author: tag !== '' ? tag : this.comments.resolvedAuthor(),
			date: todayISO(),
			body: trimmed,
		};
		// Only claim success when something was written. A refused write has
		// already explained itself with its own notice, and the composer keeps
		// the text so the user can retry once the note catches up.
		const path =
			sourcePath && sourcePath !== ''
				? sourcePath
				: this.app.workspace.getActiveFile()?.path;
		if (!path) return false;
		const wrote = await this.comments.appendReply(path, comment, reply);
		if (wrote) new Notice('Reply added.');
		return wrote;
	}

	// Author picker options (F-274): the global author tag, the configured
	// collaborator tags, and any authors already in the given thread, deduped.
	authorPickerOptions(threadAuthors: string[]): string[] {
		return authorPickerOptions(
			this.comments.resolvedAuthor(),
			this.settings.authorStyles,
			threadAuthors,
		);
	}

	// Per-author color (F-275), or undefined when the author has no style.
	authorColor(tag: string): string | undefined {
		return authorColorFor(tag, this.settings.authorStyles);
	}

	async copyCommentId(comment: Comment): Promise<void> {
		if (!comment.id) {
			new Notice('This comment has no ID.');
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
			new Notice('This comment has no ID and cannot be starred.');
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
		this.events.trigger('starred-changed', { id: comment.id });
	}

	async setLastHubTab(tab: AnnotecaSettings['lastHubTab']): Promise<void> {
		if (this.settings.lastHubTab === tab) return;
		this.settings.lastHubTab = tab;
		await this.saveSettings();
	}

	// Reply draft persistence (vault-local, not synced) ------------------
	// Keyed by comment id. Saved on textarea input (debounced by callers);
	// loaded when the composer popup opens; cleared on Send.

	loadDraft(commentId: string): string {
		const raw: unknown = this.app.loadLocalStorage(
			this.draftKey(commentId),
		);
		return typeof raw === 'string' ? raw : '';
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
			new Notice('Open the file to edit this comment.');
			return;
		}
		this.openEditModal(view.editor, path, comment);
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
		this.settings.scopeState = {
			shape,
			anchorPath,
			pinned: this.settings.scopeState.pinned,
		};
		await this.saveSettings();
		this.events.trigger('scope-changed');
	}

	async togglePinScope(): Promise<void> {
		this.settings.scopeState.pinned = !this.settings.scopeState.pinned;
		await this.saveSettings();
		this.events.trigger('scope-changed');
	}

	async setStatusFilter(f: StatusFilter): Promise<void> {
		if (this.settings.statusFilter === f) return;
		this.settings.statusFilter = f;
		await this.saveSettings();
		this.events.trigger('scope-changed');
	}

	// Returns the set of vault-relative file paths that satisfy the current
	// scope shape. For tag/property scope, queries the metadata cache. For
	// folder scope, prefix-matches against vault paths. For vault scope,
	// returns every markdown file.
	computeScopeFiles(): Set<string> {
		const state = this.settings.scopeState;

		// Single-file scope falls back to the active file when no anchor is
		// stored. Resolve that here so the pure dispatch sees a concrete path.
		let anchorPath: string | undefined = state.anchorPath || undefined;
		if (state.shape.kind === 'file' && !anchorPath) {
			const active = this.app.workspace.getActiveFile();
			if (active) anchorPath = active.path;
		}

		const allFiles = this.app.vault.getMarkdownFiles();
		const files: ScopeFile[] = allFiles.map((f) => {
			const cache = this.app.metadataCache.getFileCache(f);
			return {
				path: f.path,
				parentPath: f.parent?.path,
				isInRoot: f.parent?.isRoot() ?? false,
				frontmatter: cache?.frontmatter,
				tags: cache ? (getAllTags(cache) ?? []) : [],
			};
		});

		return computeScopeFileSet(files, state.shape, anchorPath);
	}

	// Called when the workspace's active file changes. If the new file falls
	// outside the current scope and the scope is not pinned, collapse the
	// scope to "this file" so the panel keeps showing relevant content. When
	// the new file is inside the current scope, leave the scope alone.
	private onActiveFileChangedForScope(file: TFile): void {
		const state = this.settings.scopeState;
		if (state.pinned) return;
		if (state.shape.kind === 'vault') return;
		if (state.shape.kind === 'file') {
			// Single-file scope always follows the active file.
			if (state.anchorPath !== file.path) {
				void this.setScopeShape({ kind: 'file' }, file.path);
			}
			return;
		}
		const inScope = this.computeScopeFiles().has(file.path);
		if (!inScope) {
			void this.setScopeShape({ kind: 'file' }, file.path);
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
		const result = {
			properties: [] as Array<{ key: string; value: string }>,
			tags: [] as string[],
		};
		if (!active) return result;
		const cache = this.app.metadataCache.getFileCache(active);
		if (!cache) return result;
		if (cache.frontmatter) {
			for (const [key, raw] of Object.entries(cache.frontmatter)) {
				if (key === 'position') continue;
				if (
					typeof raw === 'string' ||
					typeof raw === 'number' ||
					typeof raw === 'boolean'
				) {
					result.properties.push({ key, value: String(raw) });
				} else if (Array.isArray(raw)) {
					for (const v of raw) {
						if (
							typeof v === 'string' ||
							typeof v === 'number' ||
							typeof v === 'boolean'
						) {
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

	async navigateToComment(
		path: string,
		start: number,
		comment?: Comment,
	): Promise<void> {
		await this.navigateToOffset(path, start);
		if (comment) this.openReviewerOnComment(comment, path);
	}

	// `force` bypasses the "already visible -> don't move" short-circuit so the
	// per-card sync button (F-291) can always re-anchor the document, even when
	// the marker is on screen and the alignment is "minimal".
	async navigateToOffset(
		path: string,
		offset: number,
		force = false,
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice('File not found.');
			return;
		}

		// Find an existing markdown leaf showing this file. We cannot rely on
		// getActiveViewOfType(MarkdownView) here because the call site is often
		// the hub panel (right sidebar), which is the active leaf when the
		// user clicks a navigate button. The active view in that moment is
		// the hub, not a MarkdownView, so the cursor + scroll calls would be
		// gated out and produce a silent no-op.
		let targetLeaf: WorkspaceLeaf | null = null;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view as MarkdownView;
			if (view.file?.path === path) {
				targetLeaf = leaf;
				break;
			}
		}
		if (!targetLeaf) {
			targetLeaf = this.app.workspace.getLeaf('tab');
			await targetLeaf.openFile(file);
		}

		const view = targetLeaf.view as MarkdownView;
		const pos = view.editor.offsetToPos(offset);
		view.editor.setCursor(pos);

		// F-276/F-289: anchor the marker per the user's alignment preference.
		// "minimal" preserves the don't-yank behavior; "top"/"center" always
		// scroll so the reading position is predictable.
		const action = decideScrollAction(
			this.settings.markerScrollAlign,
			this.isOffsetVisible(view, offset),
			force,
		);
		this.applyScrollAction(view, offset, action);
		this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
	}

	// Execute a resolved scroll action against the editor. "top" anchors the
	// marker near the top of the pane via the CodeMirror view (Obsidian's
	// editor.scrollIntoView only centers or does the minimum); it degrades to a
	// minimal scroll when the CM view is unavailable.
	private applyScrollAction(
		view: MarkdownView,
		offset: number,
		action: ScrollAction,
	): void {
		if (action === 'none') return;
		const cm = view.editor.cm;
		if (action === 'top' && cm) {
			cm.dispatch({
				effects: EditorView.scrollIntoView(offset, {
					y: 'start',
					yMargin: TOP_SCROLL_MARGIN_PX,
				}),
			});
			return;
		}
		const pos = view.editor.offsetToPos(offset);
		view.editor.scrollIntoView({ from: pos, to: pos }, action === 'center');
	}

	// True when the given document offset is inside the editor's current
	// viewport. Uses the CodeMirror view (editor.cm) for pixel-accurate bounds.
	// When the CM view or the position's coordinates are unavailable (offset far
	// outside the rendered range), report not-visible so the caller does a
	// minimal scroll rather than risk leaving the target off-screen.
	private isOffsetVisible(view: MarkdownView, offset: number): boolean {
		const cm = view.editor.cm;
		if (!cm) return false;
		const coords = cm.coordsAtPos(offset);
		if (!coords) return false;
		const rect = cm.scrollDOM.getBoundingClientRect();
		return coords.top >= rect.top && coords.bottom <= rect.bottom;
	}

	private async jumpToAdjacentComment(
		editor: Editor,
		view: MarkdownView,
		direction: 'next' | 'previous',
		unresolvedOnly: boolean,
	): Promise<void> {
		const currentFile = view.file;
		if (!currentFile) return;

		// Gather every comment in the current scope across all files. The
		// "next/previous" navigation walks this combined list so users can
		// triage by chapter or by book without bouncing back to single-file.
		interface Located {
			path: string;
			comment: Comment;
		}
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
			new Notice('No matching comments in scope.');
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

		if (direction === 'next') {
			target = all.find((item) => {
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
				if (
					item.path < currentPath ||
					item.comment.marker.start < cursorOffset
				) {
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
		// F-276: revealLeaf below uncollapses the right sidebar, which narrows
		// and reflows the document editor and would otherwise shift the reading
		// position. Capture the editor's scroll before the reveal and restore it
		// after, so opening the panel keeps the document exactly where it was.
		const restoreScroll = this.captureEditorScrollForPath(filePath);
		// Activate the view first so its active-comment-changed listener exists
		// before we emit. If the view is newly created, setViewState resolves
		// after onOpen runs and the listener is registered. If the view is
		// already open, the listener is registered from its earlier onOpen.
		// Emitting before activation lost the event on first open and made
		// the panel fall back to comments[0] (the first item).
		void this.activateView(ANNOTECA_HUB_VIEW_TYPE, 'right').then(() => {
			restoreScroll();
			this.events.trigger('active-comment-changed', {
				path: filePath,
				start,
			});
			this.highlightActiveComment(filePath, start);
		});
	}

	// Snapshot the scroll position of the editor showing `path` and return a
	// restore function. The restore runs on the next animation frame so it lands
	// after the sidebar reflow settles. No-op when the file is not open in a
	// markdown editor.
	private captureEditorScrollForPath(path: string): () => void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file?.path === path) {
				const editor = v.editor;
				const info = editor.getScrollInfo();
				return () => {
					window.requestAnimationFrame(() =>
						editor.scrollTo(info.left, info.top),
					);
				};
			}
		}
		return () => undefined;
	}

	// F-276: paint the active-comment background in the editor showing `path`
	// and clear it in every other markdown editor, so exactly one comment is
	// highlighted at a time. `start` of null clears everywhere.
	private highlightActiveComment(path: string, start: number | null): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const v = leaf.view;
			if (!(v instanceof MarkdownView)) continue;
			const cm = v.editor.cm;
			if (!cm) continue;
			const match = v.file?.path === path;
			setActiveComment(cm, match ? start : null);
		}
	}

	// Clear the active-comment highlight in every markdown editor. Called when
	// the comment panel closes (deselect).
	clearActiveCommentHighlight(): void {
		this.highlightActiveComment('', null);
	}

	// Display toggles ----------------------------------------------------

	// Hide-all is one switch for every editor, not a per-pane setting. The
	// extension keeps its own inventory of the editors it is installed in, so
	// this does not sweep workspace leaves: that would miss embedded editors
	// such as Canvas cards, which the workspace does not expose as markdown
	// leaves.
	private toggleHideAll(): boolean {
		const next = !isHideAllComments();
		setHideAllCommentsEverywhere(next);
		return next;
	}

	// Inline comment bodies are one switch for every editor too, for the same
	// reason: hide-all and show-bodies are opposites, so a reader with a split
	// pane would find it arbitrary that one reaches both panes and the other
	// does not. State is transient by design and does not survive a reload;
	// a bird's-eye view is something you turn on to scan and turn off again.
	private toggleShowCommentBodies(): boolean {
		const next = !isShowingCommentBodies();
		setShowCommentBodiesEverywhere(next);
		return next;
	}

	private async cycleIndicatorStyle(): Promise<void> {
		const order: AnnotecaSettings['indicatorStyle'][] = [
			'both',
			'icon',
			'underline',
			'none',
		];
		const idx = order.indexOf(this.settings.indicatorStyle);
		const next = order[(idx + 1) % order.length] ?? 'both';
		this.settings.indicatorStyle = next;
		await this.saveSettings();
		new Notice(`Indicator style: ${next}.`);
	}

	// Diagnostics commands live in DiagnosticsService. ---------------------

	// Run an async command body, surfacing failure as a Notice. Obsidian
	// command callbacks are synchronous; without this, a rejection from an
	// awaited body becomes an unhandled rejection the user never sees and
	// a long-running scan can die silently partway through.
	private runGuarded(label: string, action: () => Promise<void>): void {
		action().catch((err: unknown) => {
			console.error(`Annoteca: ${label} failed`, err);
			const detail = err instanceof Error ? err.message : String(err);
			new Notice(`Annoteca: ${label} failed. ${detail}`);
		});
	}

	// Writes the assistant-facing SKILL.md into the vault. Public: the settings
	// tab's Export button and the command both route here. Dot-folders are
	// invisible to the Vault file index, so this writes through the DataAdapter.
	exportAiSkill(): void {
		this.runGuarded('Skill export', async () => {
			const body = buildSkillMarkdown(
				resolveSettingsCategories(this.settings),
				this.settings.enableAuthorTag
					? this.settings.authorTag
					: undefined,
			);
			const adapter = this.app.vault.adapter;
			const paths = skillTargetPaths(this.settings.skillExportTarget);
			for (const filePath of paths) {
				const segments = filePath.split('/').slice(0, -1);
				let dir = '';
				for (const segment of segments) {
					dir = dir === '' ? segment : `${dir}/${segment}`;
					if (!(await adapter.exists(normalizePath(dir)))) {
						await adapter.mkdir(normalizePath(dir));
					}
				}
				await adapter.write(normalizePath(filePath), body);
			}
			// Record what we exported so the staleness check and the settings
			// indicator know the on-disk skill is current; suppress the load
			// notice for this schema version.
			this.settings.exportedSkillVersion = SKILL_SCHEMA_VERSION;
			this.settings.skillStaleNoticeShownFor = SKILL_SCHEMA_VERSION;
			await this.saveSettings();
			new Notice(`Skill written to ${paths.join(' and ')}.`);
		});
	}

	// Read the lowest schema version among the exported skill files on disk
	// (both targets are checked, regardless of the current target setting), or
	// null when no skill has been exported. "Lowest" so a partially-updated pair
	// reports as stale.
	async readExportedSkillVersion(): Promise<number | null> {
		const adapter = this.app.vault.adapter;
		let found: number | null = null;
		for (const filePath of skillTargetPaths('both')) {
			const p = normalizePath(filePath);
			if (!(await adapter.exists(p))) continue;
			const version = parseSkillVersion(await adapter.read(p));
			found = found === null ? version : Math.min(found, version);
		}
		return found;
	}

	// Status of the exported skill for the settings indicator.
	async readExportedSkillStatus(): Promise<SkillStatus> {
		const version = await this.readExportedSkillVersion();
		if (version === null) return 'missing';
		return version < SKILL_SCHEMA_VERSION ? 'stale' : 'current';
	}

	// On load: if an exported skill exists and is older than the current schema
	// version, warn once per bump so the user knows to re-export. The settings
	// indicator carries the persistent signal; this is the nudge.
	private async checkSkillStaleness(): Promise<void> {
		const version = await this.readExportedSkillVersion();
		if (version === null || version >= SKILL_SCHEMA_VERSION) return;
		if (this.settings.skillStaleNoticeShownFor === SKILL_SCHEMA_VERSION)
			return;
		new Notice(
			"Annoteca's AI skill guidance changed. Re-export it from settings so your assistant gets the new instructions.",
			8000,
		);
		this.settings.skillStaleNoticeShownFor = SKILL_SCHEMA_VERSION;
		await this.saveSettings();
	}

	private async backupSettings(): Promise<void> {
		const filename =
			this.settings.settingsBackupPath ?? `Annoteca settings backup.json`;
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
		const filename =
			this.settings.settingsBackupPath ?? `Annoteca settings backup.json`;
		const file = this.app.vault.getAbstractFileByPath(filename);
		if (!(file instanceof TFile)) {
			new Notice(`Backup file not found: ${filename}.`);
			return;
		}
		const body = await this.app.vault.read(file);
		try {
			const parsed = JSON.parse(body) as Partial<AnnotecaSettings>;
			this.settings = {
				...DEFAULT_SETTINGS,
				...this.settings,
				...parsed,
			};
			await this.saveSettings();
			new Notice('Settings restored.');
		} catch (err) {
			// Surface the parse failure to the console for bug reports; the
			// Notice alone hides which line of the backup was malformed.
			console.error('Annoteca: settings restore failed', err);
			new Notice('Backup file is not valid JSON.');
		}
	}

	private confirmAndConvert(format: ImportFormat): void {
		const description =
			format === 'native'
				? "Convert every %%comment%% in the vault into an Annoteca marker with the 'uncategorized' category."
				: format === 'html'
					? "Convert every plain HTML comment in the vault (anything not already in Annoteca format) into an Annoteca marker with the 'uncategorized' category."
					: "Convert every native and plain HTML comment in the vault into Annoteca markers with the 'uncategorized' category.";
		new ConfirmBackupModal(
			this.app,
			'Convert comments',
			description,
			() => {
				this.runGuarded('Comment conversion', () =>
					this.runBulkConvert(format),
				);
			},
		).open();
	}

	private async runBulkConvert(format: ImportFormat): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		let totalConverted = 0;
		let filesTouched = 0;
		for (const f of files) {
			const content = await this.app.vault.read(f);
			const result = convertAllComments(content, format, 'uncategorized');
			if (result.converted === 0) continue;
			await this.app.vault.modify(f, result.updated);
			this.commentIndex.rebuild(f.path, result.updated);
			totalConverted += result.converted;
			filesTouched += 1;
		}
		this.events.trigger('index-changed');
		new Notice(
			`Converted ${totalConverted} comment(s) across ${filesTouched} file(s).`,
		);
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
			new Notice('Index not ready.');
			return;
		}
		const found = idx.comments.find(
			(c) => offset >= c.marker.start && offset <= c.marker.end,
		);
		if (!found) {
			new Notice('No comment here.');
			return;
		}
		handler(file.path, found);
	}

	// Same lookup, but for the three addressed-state actions. Kept separate so a
	// comment that is not addressed gets told so, instead of the command
	// appearing to run and silently doing nothing: every one of
	// acceptAddressed / reviseAddressed / rejectAddressed returns early when
	// `addressed` is absent, which from a hotkey is indistinguishable from a
	// broken binding.
	private withAddressedCommentAtCursor(
		editor: Editor,
		view: MarkdownView,
		handler: (path: string, c: Comment) => void,
	): void {
		this.withCommentAtCursor(editor, view, (path, c) => {
			if (!c.addressed) {
				new Notice('This comment has no addressed edit to act on.');
				return;
			}
			handler(path, c);
		});
	}

	private async activateView(
		type: string,
		placement: 'right' | 'tab',
	): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(type);
		let leaf: WorkspaceLeaf | null = leaves[0] ?? null;
		if (!leaf) {
			leaf =
				placement === 'right'
					? this.app.workspace.getRightLeaf(false)
					: this.app.workspace.getLeaf('tab');
			if (!leaf) return;
			await leaf.setViewState({ type, active: true });
		}
		// revealLeaf, not setActiveLeaf: the hub leaf is pre-created at startup
		// with active:false, so it always exists, and setActiveLeaf on a leaf in
		// a collapsed sidebar does not expand the sidebar (the panel "never
		// opened"). revealLeaf uncollapses the sidebar and, awaited, resolves a
		// DeferredView so listeners registered in the view's onOpen exist before
		// callers emit events at it.
		await this.app.workspace.revealLeaf(leaf);
	}
}
