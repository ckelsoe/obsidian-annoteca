import { App, Modal, Setting } from 'obsidian';

import type { Comment } from './types';
import { getCategoryOrFallback } from './categories';
import { resolveSettingsCategories } from './settings';
import type { AnnotecaSettings } from './types';

// Confirmation prompt for single-comment delete. Wired into the plugin's
// pass-through so every entry point (Thread tab action, editor right-click
// menu, command palette) gets the same gate. The bulk delete-all-resolved
// flow has its own modal below and is not double-confirmed.
// Wording override for reuse by the "Resolve and remove" flow, which is the
// same destructive marker removal under a different verb.
export interface ConfirmCommentLabels {
	title: string;
	cta: string;
}

export class ConfirmDeleteCommentModal extends Modal {
	private readonly settings: AnnotecaSettings;
	private readonly comment: Comment;
	private readonly onConfirm: () => void;
	private readonly labels: ConfirmCommentLabels;
	// Optional, because most callers only care about the confirm path. The one
	// that needs it wraps this modal in a promise, and without a cancel signal
	// that promise never settles: backing out left it pending forever.
	private readonly onCancel: (() => void) | undefined;
	// Fired from onClose rather than from the Cancel button, because the button
	// is only one of the ways out. Escape and a click on the background both go
	// straight to onClose, and those are the common dismissals.
	private confirmed = false;

	constructor(
		app: App,
		settings: AnnotecaSettings,
		comment: Comment,
		onConfirm: () => void,
		labels: ConfirmCommentLabels = {
			title: 'Delete comment',
			cta: 'Delete',
		},
		onCancel?: () => void,
	) {
		super(app);
		this.settings = settings;
		this.comment = comment;
		this.onConfirm = onConfirm;
		this.labels = labels;
		this.onCancel = onCancel;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: this.labels.title });

		const enabled = resolveSettingsCategories(this.settings);
		const def = getCategoryOrFallback(this.comment.category, enabled);

		const preview = contentEl.createDiv({
			cls: 'annoteca-confirm-preview',
		});
		preview.createSpan({
			cls: `annoteca-reviewer-category annoteca-cat-${def.id}`,
			text: def.displayName,
		});
		const body =
			this.comment.body.length > 200
				? this.comment.body.slice(0, 200) + '…'
				: this.comment.body;
		preview.createDiv({ cls: 'annoteca-confirm-body', text: body });

		contentEl.createEl('p', {
			text: 'This removes the marker from the file. If the file is open in an editor you can undo with Ctrl/Cmd+Z.',
		});

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText(this.labels.cta)
					.then((btn) => btn.buttonEl.addClass('mod-warning'))
					.onClick(() => {
						// Set BEFORE close(), because close() runs onClose
						// synchronously and onClose is where cancellation is
						// decided.
						this.confirmed = true;
						this.close();
						this.onConfirm();
					}),
			)
			.addButton((b) =>
				b.setButtonText('Cancel').onClick(() => this.close()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) this.onCancel?.();
	}
}

// Lightweight confirmation modal for the single-file "delete all resolved"
// command. No backup-acknowledgement toggle: single-file deletes are
// recoverable via editor undo when the file is open.
export class ConfirmDeleteResolvedModal extends Modal {
	private readonly resolvedCount: number;
	private readonly fileBasename: string;
	private readonly onConfirm: () => void;

	constructor(
		app: App,
		resolvedCount: number,
		fileBasename: string,
		onConfirm: () => void,
	) {
		super(app);
		this.resolvedCount = resolvedCount;
		this.fileBasename = fileBasename;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: 'Delete resolved comments' });
		const noun = this.resolvedCount === 1 ? 'comment' : 'comments';
		contentEl.createEl('p', {
			text: `Delete ${this.resolvedCount} resolved ${noun} from ${this.fileBasename}?`,
		});
		contentEl.createEl('p', {
			text: 'Resolved comments preserve review history. Deleted markers cannot be reopened. If the file is open in an editor you can undo with Ctrl/Cmd+Z.',
		});

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText('Delete')
					.then((btn) => btn.buttonEl.addClass('mod-warning'))
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			)
			.addButton((b) =>
				b.setButtonText('Cancel').onClick(() => this.close()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Two-step confirmation modal used by the bulk-conversion command (F-230)
// before it touches any file in the vault.

export class ConfirmBackupModal extends Modal {
	private readonly title: string;
	private readonly description: string;
	private readonly onConfirm: () => void;
	private acknowledged = false;

	constructor(
		app: App,
		title: string,
		description: string,
		onConfirm: () => void,
	) {
		super(app);
		this.title = title;
		this.description = description;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: this.title });
		contentEl.createEl('p', { text: this.description });
		contentEl.createEl('p', {
			text: 'This operation modifies every Markdown file in your vault and cannot be reversed by the plugin. Use Git, Obsidian Sync, or an external backup to make sure you can roll back.',
		});

		new Setting(contentEl)
			.setName('I have a current backup of the vault')
			.addToggle((t) =>
				t.onChange((v) => {
					this.acknowledged = v;
				}),
			);

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText('Run conversion')
					.then((btn) => btn.buttonEl.addClass('mod-warning'))
					.onClick(() => {
						if (!this.acknowledged) return;
						this.close();
						this.onConfirm();
					}),
			)
			.addButton((b) =>
				b.setButtonText('Cancel').onClick(() => this.close()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
