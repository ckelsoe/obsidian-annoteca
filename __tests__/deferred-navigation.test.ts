/**
 * @jest-environment jsdom
 */
// The deferred-leaf half of M12, plus the two things that hang off it.
//
// #24 taught navigateToOffset to find a leaf restored from a saved workspace,
// which closed the duplicate-tab bug. It then called `loadIfDeferred()` and
// treated the result as a usable editor. It is not: the real API resolves as
// soon as the view OBJECT exists, handing back a MarkdownView whose `file` is
// still null and whose document is EMPTY. Every offset then measures against
// an empty buffer, and `coordsAtPos` past the end THROWS RangeError rather
// than returning null. isOffsetVisible is evaluated eagerly as an argument to
// decideScrollAction, so no markerScrollAlign setting avoids it, and every
// caller navigates with `void`, so it surfaced as an unhandled rejection: the
// cursor stayed where it was and the hub never selected the comment.
//
// The previous harness for this could not see it, because its fake
// `loadIfDeferred()` synchronously swapped in a fully built view with a ready
// editor. That is the one thing the real API does not do, so the fake asserted
// the bug away. This file models the real shape instead: loadIfDeferred
// resolves EMPTY, and only openFile puts the text in.

import { MarkdownView, TFile } from 'obsidian';
import AnnotecaPlugin from '../main';
import { CommentIndex } from '../index';
import { serialize } from '../parser';
import { DEFAULT_SETTINGS } from '../settings';
import type { Comment } from '../types';

// Private surface reached for here, declared standalone rather than
// intersected with AnnotecaPlugin: an intersection that re-declares a private
// member collapses to `never`. Same admission as orphan-stars.test.ts.
interface PluginUnderTest {
	commentIndex: CommentIndex;
	settings: typeof DEFAULT_SETTINGS;
	navigateToOffset(
		path: string,
		offset: number,
		force?: boolean,
	): Promise<void>;
	notifyComposerSubmitted(path: string, markerStart: number): Promise<void>;
	editCommentFromReviewer(path: string, comment: Comment): Promise<void>;
	isOffsetVisible(view: unknown, offset: number): boolean;
	ensureLeafLoadedForPath(path: string): Promise<boolean>;
}

const NOTE = `Opening line. ${serialize({
	id: 'aaaaaaaa',
	category: 'tone',
	body: 'the old one',
})} middle.\n\nClosing line.`;

// An editor over a string. `cm` mirrors only what isOffsetVisible touches, and
// coordsAtPos THROWS past the end of the document, which is the actual
// CodeMirror contract and the whole reason the guard exists.
function fakeEditor(read: () => string) {
	const cursor: { offset: number } = { offset: -1 };
	return {
		cursor,
		getValue: read,
		offsetToPos: (o: number) => ({ line: 0, ch: o }),
		posToOffset: (p: { ch: number }) => p.ch,
		setCursor: (p: { ch: number }) => {
			cursor.offset = p.ch;
		},
		scrollIntoView: () => undefined,
		cm: {
			state: {
				get doc() {
					return { length: read().length };
				},
			},
			coordsAtPos(o: number) {
				if (o > read().length)
					throw new RangeError(
						`Invalid position ${o} in document of length ${read().length}`,
					);
				return { top: 10, bottom: 20 };
			},
			scrollDOM: {
				getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
			},
			dispatch: () => undefined,
		},
	};
}

// A markdown leaf that starts DEFERRED. loadIfDeferred resolves with the view
// present but empty and file null, exactly as Obsidian does; openFile is what
// actually loads it.
function deferredLeaf(path: string, text: string) {
	let loadedText = '';
	const editor = fakeEditor(() => loadedText);
	// A real MarkdownView instance, because the production guards are
	// `instanceof MarkdownView` and a plain object silently fails all of them.
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		file: null as TFile | null,
		editor,
		// waitForEditorContent schedules through the view's OWN window, so a
		// popout gets its own timers.
		// `isConnected` because the wait re-validates the view on every pass.
		containerEl: { win: window, isConnected: true },
	}) as {
		file: TFile | null;
		editor: ReturnType<typeof fakeEditor>;
		containerEl: { win: Window; isConnected: boolean };
	};
	const leaf = {
		isDeferred: true,
		view,
		openFileCalls: 0,
		getViewState: () => ({ state: { file: path } }),
		loadIfDeferred: () => {
			// The view object appears. The FILE does not.
			leaf.isDeferred = false;
			return Promise.resolve();
		},
		// Resolves with `file` set and the buffer STILL EMPTY, filling a few
		// ticks later. Measured in the running app rather than assumed: at the
		// moment openFile resolves, view.file is already set and the editor is
		// empty through a microtask, an animation frame and a 0 ms timeout,
		// filling three frames after that. Modelling it as synchronous is what
		// would let a cursor-at-0 bug pass.
		openFile: (f: TFile) => {
			leaf.openFileCalls += 1;
			view.file = f;
			window.setTimeout(() => {
				loadedText = text;
			}, 20);
			return Promise.resolve();
		},
		// A leaf that is ALREADY showing the file, with no pending load. Used
		// for the control cases, which must not go through the deferred path.
		loadNow(f: TFile) {
			view.file = f;
			loadedText = text;
		},
	};
	return leaf;
}

function loadedLeaf(path: string, text: string) {
	const leaf = deferredLeaf(path, text);
	leaf.isDeferred = false;
	leaf.loadNow(
		Object.assign(new TFile(), {
			path,
			extension: 'md',
			stat: { size: text.length },
		}),
	);
	return leaf;
}

function makePlugin(
	leaves: ReturnType<typeof deferredLeaf>[],
	opts: { activeView?: unknown; files?: Record<string, string> } = {},
) {
	const files = opts.files ?? { 'notes/a.md': NOTE };
	const tfile = (path: string): TFile =>
		Object.assign(new TFile(), {
			path,
			extension: 'md',
			// waitForEditorContent short-circuits on a genuinely empty note.
			stat: { size: (files[path] ?? '').length },
		});
	const activeLeafSet: unknown[] = [];
	const plugin = Object.create(
		AnnotecaPlugin.prototype,
	) as unknown as PluginUnderTest;
	const openedComposers: { path: string | undefined }[] = [];
	Object.assign(plugin, {
		commentIndex: new CommentIndex(),
		settings: { ...DEFAULT_SETTINGS, markerScrollAlign: 'center' },
		events: { trigger: () => undefined },
		comments: {
			currentContentFor: (p: string) => {
				// "What a write would see": the open editor's buffer if there
				// is one, the vault otherwise. Mirrors CommentService.
				const leaf = leaves.find(
					(l) => l.getViewState().state.file === p,
				);
				const buffered = leaf?.view.editor.getValue();
				return Promise.resolve(
					buffered !== undefined && buffered !== ''
						? buffered
						: (files[p] ?? ''),
				);
			},
		},
		app: {
			vault: {
				getAbstractFileByPath: (p: string) =>
					files[p] !== undefined ? tfile(p) : null,
				cachedRead: (f: TFile) => Promise.resolve(files[f.path] ?? ''),
			},
			workspace: {
				getLeavesOfType: () => leaves,
				getLeaf: () => leaves[0],
				revealLeaf: () => Promise.resolve(),
				setActiveLeaf: (l: unknown) => activeLeafSet.push(l),
				getActiveViewOfType: () => opts.activeView ?? null,
			},
		},
		activateView: () => Promise.resolve(),
		openComposer: (req: { filePath?: string }) => {
			openedComposers.push({ path: req.filePath });
		},
	});
	return { plugin, activeLeafSet, openedComposers };
}

describe('navigateToOffset against a leaf that is still loading', () => {
	it('does not throw when the deferred view hands back an empty document', async () => {
		const leaf = deferredLeaf('notes/a.md', NOTE);
		const { plugin } = makePlugin([leaf]);

		// The offset the hub captured, which is past the end of the EMPTY
		// document loadIfDeferred resolves with. Before the fix this rejected
		// with RangeError out of coordsAtPos.
		await expect(
			plugin.navigateToOffset('notes/a.md', NOTE.length - 5),
		).resolves.toBeUndefined();
	});

	it('finishes the load, so the cursor lands on the marker rather than at 0', async () => {
		const leaf = deferredLeaf('notes/a.md', NOTE);
		const { plugin } = makePlugin([leaf]);
		const target = NOTE.indexOf('middle.');

		await plugin.navigateToOffset('notes/a.md', target);

		expect(leaf.openFileCalls).toBe(1);
		expect(leaf.view.editor.getValue()).toBe(NOTE);
		expect(leaf.view.editor.cursor.offset).toBe(target);
	});

	it('does not re-open a leaf that already holds the file', async () => {
		const leaf = loadedLeaf('notes/a.md', NOTE);
		const { plugin } = makePlugin([leaf]);

		await plugin.navigateToOffset('notes/a.md', 3);

		expect(leaf.openFileCalls).toBe(0);
		expect(leaf.view.editor.cursor.offset).toBe(3);
	});

	it('does not spend the whole wait budget on a genuinely empty note', async () => {
		// The buffer stays empty forever here because the note IS empty, so
		// without the stat short-circuit this would poll to the ceiling before
		// giving up. Asserting it returns promptly, not just eventually.
		const leaf = deferredLeaf('notes/empty.md', '');
		const { plugin } = makePlugin([leaf], {
			files: { 'notes/empty.md': '' },
		});

		const started = process.hrtime.bigint();
		await plugin.navigateToOffset('notes/empty.md', 0);
		const ms = Number(process.hrtime.bigint() - started) / 1e6;

		expect(ms).toBeLessThan(100);
		expect(leaf.view.editor.cursor.offset).toBe(0);
	});

	it('gives up quietly when the tab is closed while the editor is loading', async () => {
		// The wait spans real time, so the user can close the tab inside it.
		// Reading the editor off a torn-down view throws, and every caller
		// navigates with `void`, so it would surface as exactly the unhandled
		// rejection this whole change exists to end.
		const leaf = deferredLeaf('notes/a.md', NOTE);
		const { plugin } = makePlugin([leaf]);
		window.setTimeout(() => {
			// A detached leaf, modelled the way Obsidian leaves one: the
			// element is out of the document AND the editor is gone with the
			// view. Flipping only the flag would let the guard be deleted
			// without any test noticing.
			leaf.view.containerEl.isConnected = false;
			leaf.view.editor = undefined as unknown as ReturnType<
				typeof fakeEditor
			>;
		}, 5);

		await expect(
			plugin.navigateToOffset('notes/a.md', NOTE.length - 5),
		).resolves.toBeUndefined();
	});

	it('clamps an offset the note has since shrunk past', async () => {
		const leaf = loadedLeaf('notes/a.md', 'short');
		const { plugin } = makePlugin([leaf], {
			files: { 'notes/a.md': 'short' },
		});

		await plugin.navigateToOffset('notes/a.md', 9999);

		expect(leaf.view.editor.cursor.offset).toBe('short'.length);
	});

	it('ensureLeafLoadedForPath answers false instead of rejecting when the load throws', async () => {
		// The outline tab reaches this with `void ...then()` and no catch, so a
		// rejection would be an unhandled rejection and would suppress the
		// re-render. A failed load must resolve false.
		const leaf = deferredLeaf('notes/a.md', NOTE);
		leaf.openFile = () => Promise.reject(new Error('boom'));
		const { plugin } = makePlugin([leaf]);

		await expect(
			plugin.ensureLeafLoadedForPath('notes/a.md'),
		).resolves.toBe(false);
	});

	it('serializes concurrent navigations so they do not both load the leaf', async () => {
		// Two rapid clicks used to interleave their openFile / loadedMarkdownView
		// awaits and each load the same deferred leaf; the readiness wait widened
		// that window. The single-flight guard runs the second only after the
		// first settles, by which point the leaf is loaded and the second
		// short-circuits, so openFile is called exactly once.
		const leaf = deferredLeaf('notes/a.md', NOTE);
		const { plugin } = makePlugin([leaf]);

		await Promise.all([
			plugin.navigateToOffset('notes/a.md', 3),
			plugin.navigateToOffset('notes/a.md', 5),
		]);

		expect(leaf.openFileCalls).toBe(1);
	});
});

describe('isOffsetVisible', () => {
	it('reports not-visible instead of throwing past the end of the document', () => {
		const leaf = loadedLeaf('notes/a.md', 'short');
		const { plugin } = makePlugin([leaf]);

		expect(() => plugin.isOffsetVisible(leaf.view, 9999)).not.toThrow();
		expect(plugin.isOffsetVisible(leaf.view, 9999)).toBe(false);
	});

	it('still answers truthfully inside the document', () => {
		const leaf = loadedLeaf('notes/a.md', 'short');
		const { plugin } = makePlugin([leaf]);

		expect(plugin.isOffsetVisible(leaf.view, 2)).toBe(true);
	});
});

describe('notifyComposerSubmitted in panel-composer mode (m2)', () => {
	// The composer panel is a right-sidebar ItemView and holds focus when Send
	// is pressed, so getActiveViewOfType(MarkdownView) returns null. The old
	// code read that as "not this file" and fell through to cachedRead, which
	// returns the last SAVED bytes: the marker had been written through
	// editor.replaceRange a millisecond earlier and was missing from the index.
	// Because the new marker is APPENDED, every earlier offset is unmoved, so
	// the stale selection stayed valid and the hub never self-corrected.
	const APPENDED = `${NOTE}\n\n${serialize({
		id: 'bbbbbbbb',
		category: 'tone',
		body: 'the one I just typed',
	})}`;

	it('indexes the editor buffer even though the active view is the panel', async () => {
		const leaf = loadedLeaf('notes/a.md', APPENDED);
		// Disk still holds the pre-Send text, as it does before the autosave.
		const { plugin } = makePlugin([leaf], {
			activeView: null,
			files: { 'notes/a.md': NOTE },
		});

		await plugin.notifyComposerSubmitted('notes/a.md', APPENDED.length - 5);

		const bodies = (plugin.commentIndex.get('notes/a.md')?.comments ?? [])
			.map((c) => c.body)
			.sort();
		expect(bodies).toEqual(['the old one', 'the one I just typed']);
	});
});

describe('editCommentFromReviewer derives the path from the view', () => {
	const comment = (): Comment => {
		const parsed = new CommentIndex();
		parsed.rebuild('notes/a.md', NOTE);
		return parsed.get('notes/a.md')!.comments[0]!;
	};

	it('opens the composer against the loaded view, not a deferred one', async () => {
		const leaf = deferredLeaf('notes/a.md', NOTE);
		const { plugin, openedComposers } = makePlugin([leaf]);

		await plugin.editCommentFromReviewer('notes/a.md', comment());

		// The path openEditModal derived came from view.file, which is only
		// non-null because the load was finished first. Without that this is a
		// silent no-op where it used to show a notice.
		expect(openedComposers).toEqual([{ path: 'notes/a.md' }]);
	});
});
