// Shared composer form used by both the modal (AddCommentModal) and the
// side-panel composer (ComposerPanelView). The same controls render in both
// hosts; only the surrounding chrome differs.

import {
	Notice,
	Setting,
	type Editor,
	type EditorPosition,
	type MarkdownFileInfo,
} from 'obsidian';

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
import { getCategoryOrFallback } from './categories';
import { resolveSettingsCategories } from './settings';
import { shouldSubmitOnKeydown } from './view-utils';
import {
	getTemplate,
	resolvePlaceholder,
	type ModalTemplate,
} from './templates';
import { createStackedRow } from './ui-helpers';

// Shown when the tab the composer was opened from has moved on to another
// file. Deliberately not VANISHED_MESSAGE: nothing has moved or been deleted,
// and "reopen the note" is the wrong instruction when the note is fine and the
// TAB is what changed.
export function wrongFileMessage(path: string): string {
	return `That tab no longer shows ${path}, so nothing was saved. Open the note again and retry.`;
}

export interface ComposerRequest {
	editor: Editor;
	filePath: string;
	// The view the editor belongs to, so submit can ask which file that editor
	// is showing NOW. Required rather than optional: this is the only thing
	// standing between Save and a write into someone else's note, and an
	// optional field is one a future call site can forget to pass.
	//
	// Typed as MarkdownFileInfo rather than MarkdownView because that is the
	// interface carrying `file`, and it is what `editorCallback` actually hands
	// over (`MarkdownView | MarkdownFileInfo`), so no call site has to narrow.
	view: MarkdownFileInfo;
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
	// The exact marker source text as it stood WHEN THE FORM OPENED, which is
	// the whole fingerprint an id-less marker has. Captured for the same reason
	// as the offset: it has to be read before the document moves on.
	private readonly editingMarkerText: string;
	// The body textarea of the most recent render, for `focusBody`.
	private bodyArea?: HTMLTextAreaElement;
	// The category the form OPENED with. A save may always use it, even when
	// the settings no longer offer it: see categoryIsSavable.
	private readonly initialCategory: string;

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
		this.editingMarkerText = request.editing
			? request.editor
					.getValue()
					.slice(
						this.editingStartOffset,
						request.editor.posToOffset(request.editing.to),
					)
			: '';
		this.initialCategory = request.scratchpad
			? 'uncategorized'
			: (request.editing?.comment.category ??
				plugin.settings.defaultCategory);
		this.state = {
			selectedCategory: this.initialCategory,
			body: request.editing?.comment.body ?? '',
			scratchpad: !!request.scratchpad,
			templateValues: {},
		};
	}

	// Put the caret in the body field (#21). Called by the MODAL host only, and
	// only after the form is in the document: focusing a detached element does
	// nothing. The side-panel composer deliberately does not call this, because
	// its whole point is that the editor stays usable while it is open, so
	// pulling focus out of the document there would be hostile.
	//
	// Caret at the end rather than the start: on the edit path the field opens
	// with the existing body, and amending text is the expected action.
	//
	// Deferred by a turn of the event loop because a plain call loses. Verified
	// in the running app: focus went to the category dropdown, because Obsidian
	// moves focus itself after the modal's onOpen returns, so anything focused
	// during onOpen is overwritten a moment later.
	focusBody(): void {
		const area = this.bodyArea;
		if (!area) return;
		area.win.setTimeout(() => {
			// The modal can be dismissed inside that turn, and focusing a
			// detached element steals focus from whatever replaced it.
			if (!area.isConnected) return;
			area.focus();
			area.setSelectionRange(area.value.length, area.value.length);
		}, 0);
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
					// A comment can carry a category the settings no longer
					// offer. Without an option for it, setValue was called with
					// an id that had never been added, so the control rendered
					// blank: the user could not see what the comment was filed
					// under, and changing it was the only way to make the form
					// look complete. Labelled, so it is clear why it sits apart
					// from the others.
					if (
						!enabled.some(
							(c) => c.id === this.state.selectedCategory,
						)
					) {
						const shown = getCategoryOrFallback(
							this.state.selectedCategory,
							enabled,
						);
						d.addOption(
							this.state.selectedCategory,
							`${shown.displayName} (not enabled)`,
						);
					}
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
		// Held so a host can focus it after the form is attached. Reassigned on
		// every render, because each one builds a fresh textarea.
		this.bodyArea = bodyArea;
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
			unknownLines: [],
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
		// have no identity beyond their position and their own text, so the
		// marker sitting at the remembered offset has to be BYTE-IDENTICAL to the
		// one the form opened on. A document edited above the marker fails that
		// and refuses, rather than writing at an offset that now points at prose.
		//
		// The whole marker rather than a list of fields. Category plus extent
		// used to be the test, and it is not an identity: `convert comments`
		// (imports.ts) emits id-less markers with no id, no date and no author, so
		// a run of them differs only in body and two of equal body length have
		// equal extent. Deleting one line above slid the NEXT marker onto the
		// remembered offset, both guards passed, and Save destroyed a comment the
		// user never opened. Adding the body to the list closed that repro but not
		// the rule: any two fields of equal length, another author or a reply,
		// still sum to the same extent with the same body, and the rewrite would
		// then carry the WRONG marker's author, date and thread forward.
		//
		// Comparing the source text settles all of it at once and cannot drift out
		// of step with the format the way a field list does. `parseAt` only
		// matches a marker starting exactly at `start`, so this compares the same
		// span the form was opened on.
		//
		// The SNAPSHOT comparisons stay alongside it, and are not redundant. The
		// fingerprint was read out of the document using the snapshot's offsets,
		// so if that snapshot was ALREADY stale when the form opened - a Hub card
		// drawn before an edit and clicked after it, with the index refresh still
		// in flight - the fingerprint is a copy of whatever occupies those offsets
		// now, and comparing it to itself would accept anything. Category and body
		// come from the card the user actually clicked, so they are the only tie
		// back to the comment that was asked for rather than to the offsets.
		//
		// Residue, stated rather than hidden: two markers really can be
		// byte-identical, and then nothing in the file tells them apart, so a
		// drifted twin still takes the edit. That costs the edit's placement
		// between two markers that are the same character for character, and no
		// content, because every field the rewrite carries forward is identical.
		const at = parseAt(content, this.editingStartOffset);
		if (
			at !== undefined &&
			content.slice(at.marker.start, at.marker.end) ===
				this.editingMarkerText &&
			at.category === snapshot.category &&
			at.marker.end === snapshot.marker.end &&
			at.body === snapshot.body
		)
			return at;
		new Notice(VANISHED_MESSAGE);
		return undefined;
	}

	// Which categories a save may use: the enabled set, plus two that are valid
	// without being offered.
	//
	// The category the form OPENED with, because a comment already filed under
	// one the settings no longer offer has to stay editable. Both routes there
	// are ordinary UI: turn off the preset that supplied the category, or use
	// Remove on it (allowed whenever it is not the default). Refusing made
	// editing a comment's TEXT depend on its category, and the notice named no
	// way out, while the dropdown showed nothing because setValue was called
	// with an id that had never been addOption'd.
	//
	// And `uncategorized`, which is the scratchpad sentinel rather than
	// something the user picked. A categories list that has lost it, which a
	// hand edit or a sync can produce, dead-ended every scratchpad capture.
	//
	// Every DISPLAY surface already tolerates an unknown category through
	// getCategoryOrFallback. This gate was the only place that did not.
	private categoryIsSavable(
		category: string,
		enabled: readonly { id: string }[],
	): boolean {
		if (category === 'uncategorized') return true;
		// Only an EDIT is grandfathered. On a create form `initialCategory` is
		// merely the default, so allowing it unconditionally would let a NEW
		// comment be filed under a category that Settings disabled while the
		// form sat open, which is the thing this gate exists to stop. An edit
		// has an existing comment to protect; a create has nothing yet.
		if (this.request.editing && category === this.initialCategory)
			return true;
		return enabled.some((c) => c.id === category);
	}

	private async submit(): Promise<void> {
		const finalBody = this.composeFinalBody();
		if (finalBody === '') {
			new Notice('Comment body is empty.');
			return;
		}

		const enabled = resolveSettingsCategories(this.plugin.settings);
		const category = this.state.selectedCategory;
		if (!this.categoryIsSavable(category, enabled)) {
			new Notice('Selected category is not enabled.');
			return;
		}

		// Which file is this editor showing NOW? The path was captured when the
		// form opened, and every write below goes through `editor.replaceRange`,
		// so the editor decides the document, not `filePath`.
		//
		// Obsidian reuses the SAME Editor object when a markdown leaf switches
		// file (checked live on 1.13.4: the stale Editor's getValue() returns the
		// new file's buffer), and the default composer location is the side
		// panel, whose whole point is that the editor stays usable behind the
		// form. So "the tab moved on while the form was open" is ordinary: a
		// wikilink click, a file-explorer click and Make a copy all reuse the
		// current tab. Save then wrote the marker into whatever that tab now
		// showed, silently, and `onSubmitted` reindexed the file that was never
		// touched.
		//
		// Checked for CREATE as well as EDIT. The edit path is the one the
		// defect was reported against, but a new comment goes through the same
		// replaceRange and lands in the same wrong document; only the edit path
		// had any file-related guard at all, and even that one ran at open time.
		//
		// Refuse rather than redirect: the form stays open with the text the user
		// typed, which is the same reason every other refusal here leaves it open.
		// Redirecting would write into a document they cannot see.
		const showing = this.request.view.file?.path;
		if (showing !== this.request.filePath) {
			new Notice(wrongFileMessage(this.request.filePath));
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
				unknownLines: fresh.unknownLines,
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
