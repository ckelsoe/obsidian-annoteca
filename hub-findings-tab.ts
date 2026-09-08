// Findings lane for the Annoteca hub (F-283, AN-D). Shows Plumbline's findings
// for the active note, ranked and severity-floored, with a promote action per
// row.
//
// Read-only with respect to the note. Nothing here writes prose or markers: a
// row's promote action goes through the same comment-service path an external
// caller uses, which is the single writer per interop-contract 4.1.

import { MarkdownView, Notice, TFile, type App } from 'obsidian';

import {
	buildFindingsLane,
	laneSummary,
	type FindingRow,
	type FindingsLaneModel,
} from './hub-findings-model';
import { asApiHandle, asFindings } from './plumbline-client';
import type AnnotecaPlugin from './main';

// The category promoted findings land in. Resolved unconditionally by
// resolveSettingsCategories, so this renders as itself in any vault.
const PROSE_CHECK = 'prose-check';

export class FindingsTabRenderer {
	// The path the last render was for, so a stale async result cannot paint
	// over a newer note. Two notes switched quickly is the ordinary case.
	private renderedFor: string | undefined;

	constructor(
		private readonly plugin: AnnotecaPlugin,
		private readonly app: App,
		private readonly requestRerender: () => void,
	) {}

	// Whether Plumbline is present and speaking a version this build knows.
	// The tab strip asks before offering the tab at all, so an unpaired vault
	// sees nothing new (contract: degrade to unpaired behaviour).
	available(): boolean {
		return asApiHandle(this.app.plugins.getPlugin('plumbline')) !== null;
	}

	// Listen for Plumbline recomputing a note's findings. Returns an unsubscribe,
	// or null when Plumbline is absent, so the caller has nothing to clean up.
	//
	// A consumer that throws must not take down the plugin that called it, and
	// this crosses a repo boundary, so the subscribe itself is guarded too.
	subscribe(cb: (path: string) => void): (() => void) | null {
		try {
			const api = asApiHandle(this.app.plugins.getPlugin('plumbline'));
			return api === null ? null : api.onFindingsChanged(cb);
		} catch (err) {
			console.error(err);
			return null;
		}
	}

	render(container: HTMLElement): void {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			container.createEl('p', {
				text: 'No file open.',
				cls: 'annoteca-empty',
			});
			return;
		}
		const api = asApiHandle(this.app.plugins.getPlugin('plumbline'));
		if (api === null) {
			// Reachable between the tab strip's check and this one if Plumbline
			// was disabled in between.
			container.createEl('p', {
				text: 'Plumbline is not available.',
				cls: 'annoteca-empty',
			});
			return;
		}

		container.createEl('h4', { text: file.basename });
		const status = container.createEl('p', {
			text: 'Reading findings...',
			cls: 'annoteca-empty',
		});

		const path = file.path;
		this.renderedFor = path;
		void api
			.findingsFor(path)
			.then(async (raw) => {
				// The note may have changed while the promise was in flight.
				if (this.renderedFor !== path) return;
				const text = await this.app.vault.cachedRead(file);
				if (this.renderedFor !== path) return;
				status.remove();
				this.paint(
					container,
					buildFindingsLane(asFindings(raw), text),
					{
						path,
						text,
					},
				);
			})
			.catch((err: unknown) => {
				// Another plugin's failure never becomes this plugin's.
				console.error(err);
				if (this.renderedFor !== path) return;
				status.setText('Could not read findings.');
			});
	}

	private paint(
		container: HTMLElement,
		model: FindingsLaneModel,
		note: { path: string; text: string },
	): void {
		container.createEl('p', {
			text: laneSummary(model),
			cls: 'annoteca-findings-summary',
		});
		if (model.rows.length === 0 && model.collapsed.length === 0) {
			return;
		}
		const list = container.createDiv({ cls: 'annoteca-findings-list' });
		for (const row of [...model.rows, ...model.collapsed]) {
			this.renderRow(list, row, note);
		}
		if (model.hidden > 0) {
			container.createEl('p', {
				text: `${model.hidden} more not shown.`,
				cls: 'annoteca-empty',
			});
		}
	}

	private renderRow(
		list: HTMLElement,
		row: FindingRow,
		note: { path: string; text: string },
	): void {
		const el = list.createDiv({
			cls: `annoteca-finding annoteca-finding-${row.severity}`,
		});
		// A real button: it navigates, so it has to be reachable and activatable
		// from the keyboard.
		const head = el.createEl('button', {
			cls: 'annoteca-finding-head',
			attr: {
				type: 'button',
				'aria-label': `${row.text}, ${row.ruleSlug}, line ${row.line}. ${row.message}`,
			},
		});
		head.createSpan({ cls: 'annoteca-finding-line', text: `L${row.line}` });
		head.createSpan({ cls: 'annoteca-finding-text', text: row.text });
		if (row.count > 1) {
			head.createSpan({
				cls: 'annoteca-finding-count',
				text: `x${row.count}`,
			});
		}
		head.addEventListener('click', () => {
			this.reveal(note.path, row);
		});
		el.createSpan({ cls: 'annoteca-finding-rule', text: row.ruleSlug });
		el.createEl('p', {
			cls: 'annoteca-finding-message',
			text: row.message,
		});

		const promote = el.createEl('button', {
			cls: 'annoteca-finding-promote',
			text: 'Add comment',
			attr: {
				type: 'button',
				'aria-label': `Add a comment for ${row.text} at line ${row.line}`,
			},
		});
		promote.addEventListener('click', () => {
			void this.promote(note, row);
		});
	}

	// Jump to the finding in the editor.
	private reveal(path: string, row: FindingRow): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) {
				const from = view.editor.offsetToPos(row.start);
				const to = view.editor.offsetToPos(row.end);
				view.editor.setSelection(from, to);
				view.editor.scrollIntoView({ from, to }, true);
				this.app.workspace.setActiveLeaf(leaf, { focus: true });
				return;
			}
		}
		new Notice('Annoteca: open that note to jump to the finding.');
	}

	// Turn the finding into a comment, through the same path an external caller
	// uses, so the serializer, the queue and the stale-read guard are the ones
	// that already exist.
	private async promote(
		note: { path: string; text: string },
		row: FindingRow,
	): Promise<void> {
		if (row.key === '') {
			// Without a source key promotion is not idempotent, so a second press
			// would leave a duplicate.
			new Notice('Annoteca: that finding has no stable ID.');
			return;
		}
		try {
			// Re-read, because the note may have moved since the lane painted.
			// promote() refuses a stale snapshot rather than writing a marker on
			// prose that shifted, so handing it the fresh text is the difference
			// between working and failing.
			const found = this.app.vault.getAbstractFileByPath(note.path);
			const text =
				found instanceof TFile
					? await this.app.vault.cachedRead(found)
					: note.text;
			const created = await this.plugin.api.promote(
				note.path,
				[
					{
						category: PROSE_CHECK,
						body: `Plumbline flagged "${row.text}" (${row.ruleSlug}): ${row.message}`,
						anchor: { start: row.start, end: row.end },
						author: 'plumbline',
						sourceKey: row.key,
					},
				],
				text,
			);
			new Notice(
				created.length > 0
					? 'Annoteca: added a comment.'
					: 'Annoteca: that finding already has a comment.',
			);
			this.requestRerender();
		} catch (err) {
			console.error(err);
			new Notice('Annoteca: could not add the comment.');
		}
	}
}
