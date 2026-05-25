import { Plugin } from "obsidian";

export default class AnnotecaPlugin extends Plugin {
	async onload(): Promise<void> {
		// Plugin initialization. Feature wiring lands here as V1 stories ship.
	}

	onunload(): void {
		// Plugin teardown. Obsidian disposes registered commands and events automatically.
	}
}
