import { App, Modal, Setting } from "obsidian";

// Two-step confirmation modal used by the bulk-conversion command (F-230)
// before it touches any file in the vault.

export class ConfirmBackupModal extends Modal {
	private readonly title: string;
	private readonly description: string;
	private readonly onConfirm: () => void;
	private acknowledged = false;

	constructor(app: App, title: string, description: string, onConfirm: () => void) {
		super(app);
		this.title = title;
		this.description = description;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.description });
		contentEl.createEl("p", {
			text: "This operation modifies every Markdown file in your vault and cannot be reversed by the plugin. Use Git, Obsidian Sync, or an external backup to make sure you can roll back.",
		});

		new Setting(contentEl)
			.setName("I have a current backup of the vault")
			.addToggle(t => t.onChange(v => { this.acknowledged = v; }));

		new Setting(contentEl)
			.addButton(b => b
				.setButtonText("Run conversion")
				.setWarning()
				.onClick(() => {
					if (!this.acknowledged) return;
					this.close();
					this.onConfirm();
				}))
			.addButton(b => b
				.setButtonText("Cancel")
				.onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
