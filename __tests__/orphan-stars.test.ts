// m5 residue: the vault scan behind "Clear orphaned stars" is one-shot, and the
// index had no path for a note that arrives after it.
//
// The finding this closes is star LOSS, not a dead end. `clearOrphanedStars`
// treats "absent from the index" as "not in the vault" and deletes the star, and
// its own comment says the scan in front of it exists so it does not "delete
// stars that are perfectly live". But `scanVaultIfNeeded` latches on
// `vaultScanned`, which nothing resets and the hub's onOpen trips in essentially
// every session, and `registerFileEvents` had no `vault.on('create')`. So a note
// synced in afterwards and never opened was invisible for the rest of the
// session. Executed against the real chain: the Starred tab renders "All starred
// comments are missing from the vault. Run ... to remove them.", the user obeys,
// and both live stars are deleted with the notice "Cleared 2 orphaned stars."
//
// Drives the real CommentIndex and the real methods off the prototype, so what
// is under test is the plugin's own logic rather than a restatement of it.

import { TFile } from 'obsidian';
import { noticeLog } from '../__mocks__/obsidian';
import AnnotecaPlugin from '../main';
import { CommentIndex } from '../index';
import { serialize } from '../parser';

beforeEach(() => {
	noticeLog.length = 0;
});

// The private surface these tests reach for, declared standalone rather than
// intersected with AnnotecaPlugin. `vaultScanned` is private on the class, and
// an intersection that re-declares a private member collapses to `never`, so
// every access through it becomes an error TypeScript reports and the type-aware
// lint rules then flag as unsafe. Casting through `unknown` keeps the admission
// explicit and in one place, which is what comment-service.test.ts does too.
interface PluginUnderTest {
	commentIndex: CommentIndex;
	vaultScanned: boolean;
	settings: { starredComments: string[] };
	scanVaultIfNeeded(): Promise<void>;
	indexUnseenFiles(): Promise<void>;
	clearOrphanedStars(): Promise<void>;
	registerFileEvents(): void;
}

const noteWith = (id: string) =>
	`Prose. ${serialize({ id, category: 'clarify', body: 'why?' })}`;

// A vault whose file list can grow after the latch is set, which is the whole
// point: sync, another device, or an assistant writing a note.
function makeHarness(initial: Record<string, string>) {
	const files = new Map<string, string>(Object.entries(initial));
	const saved: string[][] = [];
	const tfile = (path: string): TFile => {
		const f = new TFile();
		Object.assign(f, { path, extension: 'md' });
		return f;
	};
	const plugin = Object.create(
		AnnotecaPlugin.prototype,
	) as unknown as PluginUnderTest;
	Object.assign(plugin, {
		commentIndex: new CommentIndex(),
		vaultScanned: false,
		settings: { starredComments: [] as string[] },
		events: { trigger: () => undefined },
		app: {
			vault: {
				getMarkdownFiles: () => [...files.keys()].map(tfile),
				cachedRead: (f: TFile) =>
					Promise.resolve(files.get(f.path) ?? ''),
			},
		},
		saveSettings: () => {
			saved.push([...plugin.settings.starredComments]);
			return Promise.resolve();
		},
	});
	return {
		plugin,
		saved,
		deliver(path: string, content: string) {
			files.set(path, content);
		},
	};
}

describe('clearOrphanedStars against a stale index', () => {
	it('keeps a star whose note arrived after the vault scan latched', async () => {
		const h = makeHarness({ 'welcome.md': 'nothing here' });
		// The latch is set the way the hub sets it: a full scan of the vault as
		// it was at that moment.
		await h.plugin.scanVaultIfNeeded();
		expect(h.plugin.vaultScanned).toBe(true);

		// Sync then delivers two notes holding the starred comments.
		h.deliver('a.md', noteWith('live0001'));
		h.deliver('b.md', noteWith('live0002'));
		h.plugin.settings.starredComments = ['live0001', 'live0002'];

		await h.plugin.clearOrphanedStars();

		expect(h.plugin.settings.starredComments).toEqual([
			'live0001',
			'live0002',
		]);
		expect(h.saved).toHaveLength(0);
		expect(noticeLog).toEqual(['No orphaned stars to clear.']);
	});

	it('still clears a star whose comment really is gone', async () => {
		const h = makeHarness({ 'a.md': noteWith('live0001') });
		h.plugin.settings.starredComments = ['live0001', 'dead0002'];

		await h.plugin.clearOrphanedStars();

		expect(h.plugin.settings.starredComments).toEqual(['live0001']);
		expect(h.saved).toEqual([['live0001']]);
		expect(noticeLog).toEqual(['Cleared 1 orphaned star.']);
	});

	it('clears both when a note is delivered and its comment is not the star', async () => {
		const h = makeHarness({ 'welcome.md': 'nothing here' });
		await h.plugin.scanVaultIfNeeded();
		h.deliver('a.md', noteWith('other001'));
		h.plugin.settings.starredComments = ['dead0001', 'dead0002'];

		await h.plugin.clearOrphanedStars();

		expect(h.plugin.settings.starredComments).toEqual([]);
		expect(noticeLog).toEqual(['Cleared 2 orphaned stars.']);
	});
});

describe('indexUnseenFiles', () => {
	it('does not re-read a file the index already holds', async () => {
		const h = makeHarness({ 'a.md': noteWith('live0001') });
		await h.plugin.scanVaultIfNeeded();
		// Change the bytes WITHOUT an event. A re-read would pick the new id up;
		// staleness of a known file belongs to the file-event handlers, so this
		// must leave it alone.
		h.deliver('a.md', noteWith('other001'));
		await h.plugin.indexUnseenFiles();
		const idx = h.plugin.commentIndex.get('a.md');
		expect(idx?.comments[0]?.id).toBe('live0001');
	});

	it('indexes a file the index has never seen', async () => {
		const h = makeHarness({ 'a.md': noteWith('live0001') });
		await h.plugin.scanVaultIfNeeded();
		h.deliver('b.md', noteWith('live0002'));
		expect(h.plugin.commentIndex.get('b.md')).toBeUndefined();
		await h.plugin.indexUnseenFiles();
		expect(h.plugin.commentIndex.get('b.md')?.comments[0]?.id).toBe(
			'live0002',
		);
	});
});

describe('registerFileEvents', () => {
	it("subscribes to vault 'create', deferred to layout-ready", () => {
		const vaultEvents: string[] = [];
		let layoutReady: (() => void) | undefined;
		const plugin = Object.create(
			AnnotecaPlugin.prototype,
		) as unknown as PluginUnderTest;
		Object.assign(plugin, {
			registerEvent: () => undefined,
			app: {
				vault: {
					on: (name: string) => {
						vaultEvents.push(name);
						return {};
					},
				},
				workspace: {
					on: () => ({}),
					onLayoutReady: (fn: () => void) => {
						layoutReady = fn;
					},
				},
			},
		});

		plugin.registerFileEvents();

		// Not during onload: Obsidian fires 'create' for every existing file
		// while the vault loads, so registering it there reads the whole vault
		// on startup for nothing.
		expect(vaultEvents).not.toContain('create');
		expect(layoutReady).toBeDefined();
		layoutReady?.();
		expect(vaultEvents).toContain('create');
	});
});

// The same mechanism, one method over. runDriftCheck prunes every drift snapshot
// whose id is not in `liveIds`, and builds `liveIds` from the INDEX rather than
// from the content it read on the line above. So a note absent from the index
// costs the user the drift baselines for its comments, which is the same
// "absent from the index means not in the vault" mistake as the stars, deleting
// different persisted state. Fixing only the handed case is what has produced a
// PARTIAL verdict on this project four times.
describe('runDriftCheck against a stale index', () => {
	interface DriftPlugin {
		commentIndex: CommentIndex;
		vaultScanned: boolean;
		settings: {
			driftSnapshots: Record<string, { before: string; after: string }>;
		};
		scanVaultIfNeeded(): Promise<void>;
		indexUnseenFiles(): Promise<void>;
	}

	it('keeps the snapshot of a comment in a note that arrived after the scan', async () => {
		const files = new Map<string, string>([['welcome.md', 'nothing here']]);
		const tfile = (path: string): TFile => {
			const f = new TFile();
			Object.assign(f, { path, extension: 'md' });
			return f;
		};
		const plugin = Object.create(
			AnnotecaPlugin.prototype,
		) as unknown as DriftPlugin;
		Object.assign(plugin, {
			commentIndex: new CommentIndex(),
			vaultScanned: false,
			settings: {
				driftSnapshots: {
					live0001: { before: 'a', after: 'b' },
				},
			},
			events: { trigger: () => undefined },
			app: {
				vault: {
					getMarkdownFiles: () => [...files.keys()].map(tfile),
					cachedRead: (f: TFile) =>
						Promise.resolve(files.get(f.path) ?? ''),
					// A drift finding makes the service write its report; these
					// are here only so it can, not because they are under test.
					getAbstractFileByPath: () => null,
					create: (path: string, body: string) => {
						files.set(path, body);
						return Promise.resolve(tfile(path));
					},
					modify: () => Promise.resolve(),
				},
				workspace: { getLeaf: () => ({ openFile: () => undefined }) },
			},
			saveSettings: () => Promise.resolve(),
		});

		await plugin.scanVaultIfNeeded();
		files.set('a.md', noteWith('live0001'));

		const { DiagnosticsService } = await import('../diagnostics-service');
		await new DiagnosticsService(
			plugin as unknown as AnnotecaPlugin,
		).runDriftCheck();

		expect(Object.keys(plugin.settings.driftSnapshots)).toContain(
			'live0001',
		);
	});
});
