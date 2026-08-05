import { App, Modal } from 'obsidian';

import type AnnotecaPlugin from './main';
import { ComposerForm, type ComposerRequest } from './composer';

export class AddCommentModal extends Modal {
	private readonly plugin: AnnotecaPlugin;
	private readonly request: ComposerRequest;

	constructor(app: App, plugin: AnnotecaPlugin, request: ComposerRequest) {
		super(app);
		this.plugin = plugin;
		this.request = request;
	}

	onOpen(): void {
		const form = new ComposerForm(this.plugin, this.request, {
			close: () => this.close(),
			onSubmitted: (filePath, markerStart) => {
				void this.plugin.notifyComposerSubmitted(filePath, markerStart);
			},
		});
		form.render(this.contentEl);
		// #21: the modal used to open with nothing focused, so writing a comment
		// always cost a click or tap on the body field first. That hurt most on
		// the keyboard path, which is the reason the command exists.
		form.focusBody();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
