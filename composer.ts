// Shared composer form used by both the modal (AddCommentModal) and the
// side-panel composer (ComposerPanelView). The same controls render in both
// hosts; only the surrounding chrome differs.

import { Notice, Setting, type Editor, type EditorPosition } from "obsidian";

import type AnnotecaPlugin from "./main";
import type { Comment } from "./types";
import { generateId, serialize, todayISO } from "./parser";
import { resolveSettingsCategories } from "./settings";
import { getTemplate, resolvePlaceholder, type ModalTemplate } from "./templates";
import { createStackedRow } from "./ui-helpers";

export interface ComposerRequest {
	editor: Editor;
	filePath: string;
	// When set, the form opens with the scratchpad category preselected.
	scratchpad?: boolean;
	// When set, the form opens preloaded with an existing comment for editing.
	editing?: {
		comment: Comment;
		from: EditorPosition;
		to: EditorPosition;
	};
}

export interface ComposerHooks {
	close(): void;
	onSubmitted?(filePath: string, markerStart: number): void;
}

interface ComposerState {
	selectedCategory: string;
	body: string;
	scratchpad: boolean;
	templateValues: Record<string, string>;
}

export class ComposerForm {
	private readonly plugin: AnnotecaPlugin;
	private readonly request: ComposerRequest;
	private readonly hooks: ComposerHooks;
	private readonly state: ComposerState;

	constructor(plugin: AnnotecaPlugin, request: ComposerRequest, hooks: ComposerHooks) {
		this.plugin = plugin;
		this.request = request;
		this.hooks = hooks;
		this.state = {
			selectedCategory: request.scratchpad
				? "uncategorized"
				: (request.editing?.comment.category ?? plugin.settings.defaultCategory),
			body: request.editing?.comment.body ?? "",
			scratchpad: !!request.scratchpad,
			templateValues: {},
		};
	}

	render(container: HTMLElement): void {
		container.empty();
		container.addClass("annoteca-composer");

		const heading = this.request.editing ? "Edit comment" : "Add comment";
		container.createEl("h3", { text: heading });

		const enabled = resolveSettingsCategories(this.plugin.settings);

		if (!this.state.scratchpad) {
			new Setting(container)
				.setName("Category")
				.setDesc("Filter and group by this in the views.")
				.addDropdown(d => {
					for (const c of enabled) d.addOption(c.id, c.displayName);
					d.setValue(this.state.selectedCategory);
					d.onChange(v => {
						this.state.selectedCategory = v;
						this.render(container);
					});
				});

			if (!this.request.editing) {
				new Setting(container)
					.setName("Scratchpad")
					.setDesc("Capture without picking a category. Reclassify later.")
					.addToggle(t => t
						.setValue(false)
						.onChange(value => {
							this.state.scratchpad = value;
							this.state.selectedCategory = value
								? "uncategorized"
								: this.plugin.settings.defaultCategory;
							this.render(container);
						}));
			}
		}

		const template = !this.request.editing ? getTemplate(this.state.selectedCategory) : undefined;
		if (template) this.renderTemplateFields(container, template);

		// Body field uses stacked layout (label above, full-width textarea below)
		// so it isn't crammed into the right-rail of a Setting widget. The
		// Obsidian Setting convention works for short controls but not for
		// multi-line text — same pattern used throughout the plugin now.
		const { content: bodyContent } = createStackedRow(container, {
			name: "Body",
			description: "Plain text or inline Markdown. Wikilinks are supported.",
			cls: "annoteca-composer-body-row",
		});
		const bodyArea = bodyContent.createEl("textarea", {
			cls: "annoteca-modal-body",
			attr: {
				placeholder: "Type the comment here…",
				rows: "6",
			},
		});
		bodyArea.value = this.state.body;
		bodyArea.addEventListener("input", () => {
			this.state.body = bodyArea.value;
		});

		const actions = container.createDiv({ cls: "annoteca-composer-actions" });
		const submitBtn = actions.createEl("button", {
			cls: "mod-cta",
			text: this.request.editing ? "Save" : "Insert",
			attr: { type: "button" },
		});
		submitBtn.addEventListener("click", () => { void this.submit(); });
		const cancelBtn = actions.createEl("button", {
			text: "Cancel",
			attr: { type: "button" },
		});
		cancelBtn.addEventListener("click", () => this.hooks.close());
	}

	private renderTemplateFields(container: HTMLElement, template: ModalTemplate): void {
		const wrap = container.createDiv({ cls: "annoteca-template-fields" });
		wrap.createEl("h4", { text: "Details" });

		// Editor selection feeds contextual placeholders (e.g., the
		// index-entry "term" field defaults to whatever the user highlighted
		// rather than a domain-specific example).
		const selectedText = this.request.editor.getSelection();

		for (const field of template.fields) {
			const { content } = createStackedRow(wrap, {
				name: field.label,
				cls: "annoteca-template-field",
			});
			const placeholder = resolvePlaceholder(field, { selectedText });
			if (field.type === "textarea") {
				const ta = content.createEl("textarea", {
					cls: "annoteca-template-textarea",
					attr: { placeholder, rows: "3" },
				});
				ta.value = this.state.templateValues[field.id] ?? "";
				ta.addEventListener("input", () => {
					this.state.templateValues[field.id] = ta.value;
				});
			} else {
				const input = content.createEl("input", {
					cls: "annoteca-template-input",
					attr: { type: "text", placeholder },
				});
				input.value = this.state.templateValues[field.id] ?? "";
				input.addEventListener("input", () => {
					this.state.templateValues[field.id] = input.value;
				});
			}
		}
	}

	private composeFinalBody(): string {
		const trimmed = this.state.body.trim();
		const template = !this.request.editing
			? getTemplate(this.state.selectedCategory)
			: undefined;
		if (template) {
			return template.compose(this.state.templateValues, trimmed).trim();
		}
		return trimmed;
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

	private async submit(): Promise<void> {
		const finalBody = this.composeFinalBody();
		if (finalBody === "") {
			new Notice("Comment body is empty.");
			return;
		}

		const enabled = resolveSettingsCategories(this.plugin.settings);
		const category = this.state.selectedCategory;
		if (!enabled.find(c => c.id === category)) {
			new Notice("Selected category is not enabled.");
			return;
		}

		const editor = this.request.editor;

		if (this.request.editing) {
			const existing = this.request.editing.comment;
			const updated: Comment = { ...existing, category, body: finalBody };
			const serialized = serialize({
				id: updated.id,
				category: updated.category,
				body: updated.body,
				date: updated.date,
				author: updated.author,
				replies: updated.replies,
				resolution: updated.resolution,
			});
			editor.replaceRange(serialized, this.request.editing.from, this.request.editing.to);
			this.hooks.close();
			this.hooks.onSubmitted?.(this.request.filePath, editor.posToOffset(this.request.editing.from));
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
		let markerStart: number;
		if (selection.length > 0) {
			const to = editor.getCursor("to");
			const toOffset = editor.posToOffset(to);
			editor.replaceRange(` ${text}`, to);
			markerStart = toOffset + 1;
		} else {
			const cursor = editor.getCursor();
			markerStart = editor.posToOffset(cursor);
			editor.replaceRange(text, cursor);
		}

		this.hooks.close();
		this.hooks.onSubmitted?.(this.request.filePath, markerStart);
	}
}
