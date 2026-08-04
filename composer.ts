// Shared composer form used by both the modal (AddCommentModal) and the
// side-panel composer (ComposerPanelView). The same controls render in both
// hosts; only the surrounding chrome differs.

import { Notice, Setting, type Editor, type EditorPosition } from 'obsidian';

import type AnnotecaPlugin from './main';
import type { AnchorText, Comment } from './types';
import {
	buildAnchorFromSelection,
	generateId,
	parseAll,
	parseAt,
	serialize,
	nowISO,
} from './parser';
import { VANISHED_MESSAGE, ambiguousMessage } from './comment-service';
import { resolveSettingsCategories } from './settings';
import { shouldSubmitOnKeydown } from './view-utils';
import {
	getTemplate,
	resolvePlaceholder,
	type ModalTemplate,
} from './templates';
import { createStackedRow } from './ui-helpers';

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
	// Where the marker being edited started WHEN THE FORM OPENED. Only used for
	// id-less markers, which cannot be re-found any other way. Captured here
	// rather than derived at submit time because an EditorPosition is a
	// line/column pair: text inserted above the marker moves the marker without
	// changing the pair, so converting it late silently points somewhere else.
	private readonly editingStartOffset: number;

	constructor(
		plugin: AnnotecaPlugin,
		request: ComposerRequest,
		hooks: ComposerHooks,
	) {
		this.plugin = plugin;
		this.request = request;
		this.hooks = hooks;
		this.editingStartOffset = request.editing
			? request.editor.posToOffset(request.editing.from)
			: 0;
		this.state = {
			selectedCategory: request.scratchpad
				? 'uncategorized'
				: (request.editing?.comment.category ??
					plugin.settings.defaultCategory),
			body: request.editing?.comment.body ?? '',
			scratchpad: !!request.scratchpad,
			templateValues: {},
		};
	}

	render(container: HTMLElement): void {
		container.empty();
		container.addClass('annoteca-composer');

		const heading = this.request.editing ? 'Edit comment' : 'Add comment';
		container.createEl('h3', { text: heading });

		const enabled = resolveSettingsCategories(this.plugin.settings);

		if (!this.state.scratchpad) {
			new Setting(container)
				.setName('Category')
				.setDesc('Filter and group by this in the views.')
				.addDropdown((d) => {
					for (const c of enabled) d.addOption(c.id, c.displayName);
					d.setValue(this.state.selectedCategory);
					d.onChange((v) => {
						this.state.selectedCategory = v;
						this.render(container);
					});
				});

			if (!this.request.editing) {
				new Setting(container)
					.setName('Scratchpad')
					.setDesc(
						'Capture without picking a category. Reclassify later.',
					)
					.addToggle((t) =>
						t.setValue(false).onChange((value) => {
							this.state.scratchpad = value;
							this.state.selectedCategory = value
								? 'uncategorized'
								: this.plugin.settings.defaultCategory;
							this.render(container);
						}),
					);
			}
		}

		const template = !this.request.editing
			? getTemplate(this.state.selectedCategory)
			: undefined;
		if (template) this.renderTemplateFields(container, template);

		// Body field uses stacked layout (label above, full-width textarea below)
		// so it isn't crammed into the right-rail of a Setting widget. The
		// Obsidian Setting convention works for short controls but not for
		// multi-line text — same pattern used throughout the plugin now.
		const { content: bodyContent } = createStackedRow(container, {
			name: 'Body',
			description:
				'Plain text or inline Markdown. Wikilinks are supported.',
			cls: 'annoteca-composer-body-row',
		});
		const bodyArea = bodyContent.createEl('textarea', {
			cls: 'annoteca-modal-body',
			attr: {
				placeholder: 'Type the comment here…',
				rows: '6',
			},
		});
		bodyArea.value = this.state.body;
		bodyArea.addEventListener('input', () => {
			this.state.body = bodyArea.value;
		});
		bodyArea.addEventListener('keydown', (e) => {
			if (
				shouldSubmitOnKeydown(
					e,
					this.plugin.settings.submitCommentOnEnter,
				)
			) {
				e.preventDefault();
				void this.submit();
			}
		});

		const actions = container.createDiv({
			cls: 'annoteca-composer-actions',
		});
		const submitBtn = actions.createEl('button', {
			cls: 'mod-cta',
			text: this.request.editing ? 'Save' : 'Insert',
			attr: { type: 'button' },
		});
		submitBtn.addEventListener('click', () => {
			void this.submit();
		});
		const cancelBtn = actions.createEl('button', {
			text: 'Cancel',
			attr: { type: 'button' },
		});
		cancelBtn.addEventListener('click', () => this.hooks.close());
	}

	private renderTemplateFields(
		container: HTMLElement,
		template: ModalTemplate,
	): void {
		const wrap = container.createDiv({ cls: 'annoteca-template-fields' });
		wrap.createEl('h4', { text: 'Details' });

		// Editor selection feeds contextual placeholders (e.g., the
		// index-entry "term" field defaults to whatever the user highlighted
		// rather than a domain-specific example).
		const selectedText = this.request.editor.getSelection();

		for (const field of template.fields) {
			const { content } = createStackedRow(wrap, {
				name: field.label,
				cls: 'annoteca-template-field',
			});
			const placeholder = resolvePlaceholder(field, { selectedText });
			if (field.type === 'textarea') {
				const ta = content.createEl('textarea', {
					cls: 'annoteca-template-textarea',
					attr: { placeholder, rows: '3' },
				});
				ta.value = this.state.templateValues[field.id] ?? '';
				ta.addEventListener('input', () => {
					this.state.templateValues[field.id] = ta.value;
				});
			} else {
				const input = content.createEl('input', {
					cls: 'annoteca-template-input',
					attr: { type: 'text', placeholder },
				});
				input.value = this.state.templateValues[field.id] ?? '';
				input.addEventListener('input', () => {
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

	private buildCommentForCreate(
		category: string,
		body: string,
		anchor: AnchorText | undefined,
	): Comment {
		const id = this.uniqueId();
		const date = nowISO();
		const author =
			this.plugin.settings.enableAuthorTag &&
			this.plugin.settings.authorTag !== ''
				? this.plugin.settings.authorTag
				: undefined;
		return {
			id,
			category,
			body,
			date,
			author,
			anchor,
			replies: [],
			addressed: undefined,
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

	// Find the marker this form is editing in the document as it stands NOW.
	//
	// Returns undefined on every refusal, and the caller then leaves the form
	// OPEN. The text in the body field is something the user just typed; closing
	// on a refusal would destroy it, which is the same class of loss this whole
	// change is about.
	//
	// The id path is exactly-one-or-refuse for the reason CommentService's
	// freshComment gives: ids live in file text, so copy-pasting a marker inside
	// a note produces two markers with the same id, and picking the first would
	// be a coin flip.
	private resolveEditTarget(editor: Editor): Comment | undefined {
		const editing = this.request.editing;
		if (!editing) return undefined;
		const content = editor.getValue();
		const snapshot = editing.comment;

		if (snapshot.id !== undefined) {
			const matches = parseAll(content).filter(
				(c) => c.id === snapshot.id,
			);
			const only = matches[0];
			if (matches.length === 1 && only !== undefined) return only;
			new Notice(
				matches.length > 1
					? ambiguousMessage(snapshot.id)
					: VANISHED_MESSAGE,
			);
			return undefined;
		}

		// Id-less markers stay supported because the format supports them. They
		// resolve by position plus category, which is all the file carries; a
		// document edited above the marker fails this check and refuses, rather
		// than writing at an offset that now points at prose.
		const at = parseAt(content, this.editingStartOffset);
		if (at !== undefined && at.category === snapshot.category) return at;
		new Notice(VANISHED_MESSAGE);
		return undefined;
	}

	private async submit(): Promise<void> {
		const finalBody = this.composeFinalBody();
		if (finalBody === '') {
			new Notice('Comment body is empty.');
			return;
		}

		const enabled = resolveSettingsCategories(this.plugin.settings);
		const category = this.state.selectedCategory;
		if (!enabled.find((c) => c.id === category)) {
			new Notice('Selected category is not enabled.');
			return;
		}

		const editor = this.request.editor;

		if (this.request.editing) {
			// Re-resolve against the CURRENT document rather than writing the
			// snapshot back over a remembered range. Both of the old inputs were
			// stale by the time Save was pressed, and the default composer is the
			// side panel, where the editor stays live behind the form:
			//
			//   - The SNAPSHOT was taken when the form opened, so a reply or an
			//     addressed state that landed while it was open was overwritten.
			//     It also omitted `addressed` entirely, which silently degraded
			//     Reject to Revise and dropped the annoteca-original fence, the
			//     only copy of the pre-edit prose in the file.
			//   - The RANGE drifted whenever the document changed above the
			//     marker, so the write landed on whatever now occupied those
			//     line/column pairs.
			//
			// This path does not go through CommentService, so none of its
			// freshness work covered it.
			const fresh = this.resolveEditTarget(editor);
			if (fresh === undefined) return;

			// Every tail field is listed rather than spread, because the defect
			// here was an omitted one and a list is checkable against the format.
			const serialized = serialize({
				id: fresh.id,
				category,
				body: finalBody,
				date: fresh.date,
				author: fresh.author,
				// Preserve the anchor from the original comment. Editing
				// changes the body / category, not what the comment is anchored
				// to — per data-format.md the anchor reflects the original
				// commented text and is not updated by edits.
				anchor: fresh.anchor,
				replies: fresh.replies,
				addressed: fresh.addressed,
				resolution: fresh.resolution,
			});
			editor.replaceRange(
				serialized,
				editor.offsetToPos(fresh.marker.start),
				editor.offsetToPos(fresh.marker.end),
			);
			this.hooks.close();
			this.hooks.onSubmitted?.(this.request.filePath, fresh.marker.start);
			return;
		}

		// Capture the selection BEFORE we mutate the document. Once
		// replaceRange runs the editor's selection state is gone.
		const selection = editor.getSelection();
		const anchor =
			selection.length > 0
				? buildAnchorFromSelection(selection)
				: undefined;

		const comment = this.buildCommentForCreate(category, finalBody, anchor);
		const text = serialize({
			id: comment.id,
			category: comment.category,
			body: comment.body,
			date: comment.date,
			author: comment.author,
			anchor: comment.anchor,
		});

		let markerStart: number;
		if (selection.length > 0) {
			// F-273: beginning-placement. Insert the marker at the START of the
			// selection so the text the comment concerns follows it. The leading
			// space here mirrors the old trailing-space handling: it sits between
			// the marker and the anchored prose, and findAnchorRange tolerates it
			// on the forward (begin-placed) side just as it did on the backward
			// (end-placed) side.
			const from = editor.getCursor('from');
			const fromOffset = editor.posToOffset(from);
			editor.replaceRange(`${text} `, from);
			markerStart = fromOffset;
		} else {
			const cursor = editor.getCursor();
			markerStart = editor.posToOffset(cursor);
			editor.replaceRange(text, cursor);
		}

		this.hooks.close();
		this.hooks.onSubmitted?.(this.request.filePath, markerStart);
	}
}
