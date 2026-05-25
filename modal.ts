import {
	App,
	Editor,
	Modal,
	Notice,
	Setting,
	type EditorPosition,
} from "obsidian";

import type AnnotecaPlugin from "./main";
import type { CategoryDefinition, Comment } from "./types";
import { generateId, serialize, todayISO } from "./parser";
import { resolveSettingsCategories } from "./settings";
import { getTemplate, type ModalTemplate } from "./templates";

interface ModalOptions {
	editor: Editor;
	// When set, the modal opens with this category preselected and the dropdown
	// hidden. Used by the scratchpad command (F-017).
	scratchpad?: boolean;
	// When set, the modal opens preloaded with an existing comment for the
	// "edit comment at cursor" command (F-022).
	editing?: {
		comment: Comment;
		from: EditorPosition;
		to: EditorPosition;
	};
}

export class AddCommentModal extends Modal {
	private readonly plugin: AnnotecaPlugin;
	private readonly opts: ModalOptions;

	private selectedCategory: string;
	private body: string;
	private scratchpad: boolean;
	private templateValues: Record<string, string> = {};

	constructor(app: App, plugin: AnnotecaPlugin, opts: ModalOptions) {
		super(app);
		this.plugin = plugin;
		this.opts = opts;
		this.scratchpad = !!opts.scratchpad;
		this.selectedCategory = this.scratchpad
			? "uncategorized"
			: (opts.editing?.comment.category ?? plugin.settings.defaultCategory);
		this.body = opts.editing?.comment.body ?? "";
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		const heading = this.opts.editing ? "Edit comment" : "Add comment";
		contentEl.createEl("h3", { text: heading });

		const enabled = resolveSettingsCategories(this.plugin.settings);

		if (!this.scratchpad) {
			new Setting(contentEl)
				.setName("Category")
				.setDesc("Filter and group by this in the views.")
				.addDropdown(d => {
					for (const c of enabled) d.addOption(c.id, c.displayName);
					d.setValue(this.selectedCategory);
					d.onChange(v => {
						this.selectedCategory = v;
						this.render();
					});
				});

			if (!this.opts.editing) {
				new Setting(contentEl)
					.setName("Scratchpad")
					.setDesc("Capture without picking a category. Reclassify later.")
					.addToggle(t => t
						.setValue(false)
						.onChange(value => {
							this.scratchpad = value;
							this.selectedCategory = value ? "uncategorized" : this.plugin.settings.defaultCategory;
							this.render();
						}));
			}
		}

		const template = !this.opts.editing ? getTemplate(this.selectedCategory) : undefined;
		if (template) this.renderTemplateFields(contentEl, template);

		new Setting(contentEl)
			.setName("Body")
			.setDesc("Plain text or inline Markdown. Wikilinks are supported.")
			.addTextArea(t => {
				t.setPlaceholder("Type the comment here…")
					.setValue(this.body)
					.onChange(v => { this.body = v; });
				t.inputEl.rows = 6;
				t.inputEl.addClass("annoteca-modal-body");
			});

		new Setting(contentEl)
			.addButton(b => b
				.setButtonText(this.opts.editing ? "Save" : "Insert")
				.setCta()
				.onClick(() => { void this.submit(); }))
			.addButton(b => b
				.setButtonText("Cancel")
				.onClick(() => this.close()));
	}

	private renderTemplateFields(container: HTMLElement, template: ModalTemplate): void {
		const fieldsContainer = container.createDiv({ cls: "annoteca-template-fields" });
		fieldsContainer.createEl("h4", { text: "Details" });
		for (const field of template.fields) {
			const setting = new Setting(fieldsContainer).setName(field.label);
			if (field.type === "textarea") {
				setting.addTextArea(t => {
					t.setPlaceholder(field.placeholder ?? "")
						.setValue(this.templateValues[field.id] ?? "")
						.onChange(v => { this.templateValues[field.id] = v; });
					t.inputEl.rows = 3;
				});
			} else {
				setting.addText(t => t
					.setPlaceholder(field.placeholder ?? "")
					.setValue(this.templateValues[field.id] ?? "")
					.onChange(v => { this.templateValues[field.id] = v; }));
			}
		}
	}

	private buildCommentForCreate(category: string, body: string): Comment {
		const id = this.uniqueId();
		const date = todayISO();
		const author = this.plugin.settings.enableAuthorTag && this.plugin.settings.authorTag !== ""
			? this.plugin.settings.authorTag
			: undefined;

		return {
			id,
			category,
			body,
			date,
			author,
			replies: [],
			resolution: undefined,
			marker: { start: 0, end: 0 },
		};
	}

	private uniqueId(): string {
		let id = generateId();
		for (let attempt = 0; attempt < 8; attempt++) {
			if (!this.plugin.commentIndex.hasId(id)) return id;
			id = generateId();
		}
		return id;
	}

	private composeFinalBody(): string {
		const trimmed = this.body.trim();
		const template = !this.opts.editing ? getTemplate(this.selectedCategory) : undefined;
		if (template) {
			const composed = template.compose(this.templateValues, trimmed);
			return composed.trim();
		}
		return trimmed;
	}

	private async submit(): Promise<void> {
		const finalBody = this.composeFinalBody();
		if (finalBody === "") {
			new Notice("Comment body is empty.");
			return;
		}

		const cats = resolveSettingsCategories(this.plugin.settings);
		const category = this.selectedCategory;
		if (!cats.find((c: CategoryDefinition) => c.id === category)) {
			new Notice("Selected category is not enabled.");
			return;
		}

		const editor = this.opts.editor;

		if (this.opts.editing) {
			const existing = this.opts.editing.comment;
			const updated: Comment = {
				...existing,
				category,
				body: finalBody,
			};
			const serialized = serialize({
				id: updated.id,
				category: updated.category,
				body: updated.body,
				date: updated.date,
				author: updated.author,
				replies: updated.replies,
				resolution: updated.resolution,
			});
			editor.replaceRange(serialized, this.opts.editing.from, this.opts.editing.to);
			this.close();
			return;
		}

		const comment = this.buildCommentForCreate(category, finalBody);
		const text = serialize({
			id: comment.id,
			category: comment.category,
			body: comment.body,
			date: comment.date,
			author: comment.author,
		});

		const selection = editor.getSelection();
		if (selection.length > 0) {
			const to = editor.getCursor("to");
			editor.replaceRange(` ${text}`, to);
		} else {
			const cursor = editor.getCursor();
			editor.replaceRange(`${text}`, cursor);
		}

		this.close();
	}
}
