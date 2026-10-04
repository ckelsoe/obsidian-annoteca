// Debug mode (Settings > Diagnostics). Off by default. When on, Annoteca records
// how long its own work takes: index rebuilds, vault scans, comment writes and
// the time they wait in the per-note queue, and the frontmatter summary up to
// the moment Obsidian's metadata cache (and so a Bases view) has it. Each entry
// is one JSON line, to the developer console or to a capped log file in the
// plugin folder.
//
// The setting and its destination existed long before anything read them. This
// is what makes them do what the settings tab said they did.
//
// The log file is deliberately not a markdown note. A note would be re-parsed
// by Obsidian's metadata cache and by Annoteca's own index on every append, so
// the act of logging would slow the very thing being measured.

import { normalizePath, type App } from 'obsidian';

const DEBUG_LOG_FILE = 'debug.log';
// Characters, which is bytes for the ASCII this log almost always holds. When
// the file passes MAX it is cut back to roughly the newest KEEP.
export const DEBUG_LOG_MAX_CHARS = 1_000_000;
export const DEBUG_LOG_KEEP_CHARS = 500_000;

export interface DebugSettings {
	debugMode: boolean;
	debugLogTarget: 'console' | 'vault';
}

export type DebugData = Record<string, string | number | boolean | null>;

// Milliseconds since `start` (a performance.now() reading), to 0.1 ms.
export function elapsedMs(start: number, now = performance.now()): number {
	return Math.round((now - start) * 10) / 10;
}

export function formatEntry(event: string, data: DebugData, at: Date): string {
	return `${JSON.stringify({ at: at.toISOString(), event, ...data })}\n`;
}

// The newest `keep` characters of a log, starting at a line boundary so the
// first entry is never a fragment.
export function trimLog(content: string, keep: number): string {
	if (content.length <= keep) return content;
	const tail = content.slice(content.length - keep);
	const firstBreak = tail.indexOf('\n');
	return firstBreak === -1 ? '' : tail.slice(firstBreak + 1);
}

export class DebugLog {
	// Known size of the file, so the cap is checked without a stat per entry.
	// Undefined until the first write of the session reads it.
	private size: number | undefined;
	// Writes are chained so entries land in the order they were logged.
	private writes: Promise<void> = Promise.resolve();

	constructor(
		private readonly app: App,
		private readonly dir: string,
		private readonly settings: () => DebugSettings,
	) {}

	get enabled(): boolean {
		return this.settings().debugMode;
	}

	get path(): string {
		return normalizePath(`${this.dir}/${DEBUG_LOG_FILE}`);
	}

	log(event: string, data: DebugData = {}): void {
		const s = this.settings();
		if (!s.debugMode) return;
		const line = formatEntry(event, data, new Date());
		if (s.debugLogTarget === 'console') {
			console.debug(`[Annoteca] ${line.trimEnd()}`);
			return;
		}
		this.writes = this.writes
			.then(() => this.append(line))
			.catch((err: unknown) => {
				// Never a Notice: this runs on every rebuild while debugging.
				console.error('Annoteca: debug log write failed', err);
			});
	}

	// Resolves once every entry logged so far is on disk.
	flushed(): Promise<void> {
		return this.writes;
	}

	async read(): Promise<string> {
		await this.writes;
		const adapter = this.app.vault.adapter;
		return (await adapter.exists(this.path)) ? adapter.read(this.path) : '';
	}

	private async append(line: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (this.size === undefined) {
			const stat = await adapter.stat(this.path);
			this.size = stat?.size ?? 0;
		}
		await adapter.append(this.path, line);
		this.size += line.length;
		if (this.size > DEBUG_LOG_MAX_CHARS) {
			const kept = trimLog(
				await adapter.read(this.path),
				DEBUG_LOG_KEEP_CHARS,
			);
			await adapter.write(this.path, kept);
			this.size = kept.length;
		}
	}
}
