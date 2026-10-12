// The event journal (#95). Off by default. When on, every comment event is
// appended as one JSON line to events.jsonl in the plugin folder, so a tool
// outside Obsidian can follow comments by tailing a file instead of polling
// notes. Local only: nothing here touches the network.
//
// Metadata only, never comment text or the prose it is about. The note stays
// the source of truth for content; a consumer that wants the body reads the
// note. That keeps the journal small and keeps a second copy of the user's
// writing from piling up in the plugin folder.
//
// Never rewritten in place. A tool tailing the file by name (`tail -F`) would
// read a trimmed copy as new lines and replay old events. Past the cap the
// file is renamed to events.1.jsonl, replacing the previous one, and a new
// file starts; a name-following tail picks the new file up.
//
// Not a markdown note for the same reason as the debug log: a note would be
// re-parsed by Obsidian and by Annoteca's own index on every append.

import { normalizePath, type App } from 'obsidian';
import type { CommentEvent } from './comment-events';

const EVENT_JOURNAL_FILE = 'events.jsonl';
const EVENT_JOURNAL_ROTATED = 'events.1.jsonl';
// Characters, which is bytes for the ASCII this file almost always holds.
export const EVENT_JOURNAL_MAX_CHARS = 5_000_000;

export function formatJournalLines(
	events: readonly CommentEvent[],
	at: Date,
): string {
	const stamp = at.toISOString();
	return events
		.map((e) => `${JSON.stringify({ at: stamp, ...e })}\n`)
		.join('');
}

export class EventJournal {
	// Known size of the file, so the cap is checked without a stat per write.
	// Undefined until the first write of the session reads it.
	private size: number | undefined;
	// Writes are chained so lines land in the order the events happened.
	private writes: Promise<void> = Promise.resolve();

	constructor(
		private readonly app: App,
		private readonly dir: string,
		private readonly enabled: () => boolean,
	) {}

	get path(): string {
		return normalizePath(`${this.dir}/${EVENT_JOURNAL_FILE}`);
	}

	get rotatedPath(): string {
		return normalizePath(`${this.dir}/${EVENT_JOURNAL_ROTATED}`);
	}

	write(events: readonly CommentEvent[], at = new Date()): void {
		if (!this.enabled() || events.length === 0) return;
		// One append per batch: the lines of a batch arrive together.
		const lines = formatJournalLines(events, at);
		this.writes = this.writes
			.then(() => this.append(lines))
			.catch((err: unknown) => {
				// Never a Notice: this runs on every comment change.
				console.error('Annoteca: event journal write failed', err);
				// Re-read the size next time rather than trust a count that a
				// half-finished write may have left wrong.
				this.size = undefined;
			});
	}

	// Resolves once every line written so far is on disk.
	flushed(): Promise<void> {
		return this.writes;
	}

	private async append(lines: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (this.size === undefined) {
			const stat = await adapter.stat(this.path);
			this.size = stat?.size ?? 0;
		}
		await adapter.append(this.path, lines);
		this.size += lines.length;
		if (this.size > EVENT_JOURNAL_MAX_CHARS) {
			if (await adapter.exists(this.rotatedPath))
				await adapter.remove(this.rotatedPath);
			await adapter.rename(this.path, this.rotatedPath);
			this.size = 0;
		}
	}
}
