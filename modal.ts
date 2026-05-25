import { App, Modal } from "obsidian";

import type AnnotecaPlugin from "./main";
import { ComposerForm, type ComposerRequest } from "./composer";

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
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
