// The hub panel's refresh coalescing.
//
// Several triggers fire for a single user action. Starring, changing scope,
// changing the status filter and switching tabs each have their own refresh
// path AND persist through `saveSettings()`, which emits "settings-changed",
// which the panel also refreshes on. Every one of those actions therefore
// rendered the panel twice, and a render is a full contentEl rebuild plus, on
// the Thread tab, a `computeScopeFiles()` walk of the vault.
//
// The tempting fix, dropping the "settings-changed" listener, is wrong: it is
// the ONLY refresh path for a plain settings-tab edit, for cycleIndicatorStyle
// and for the skill-staleness save, so removing it brings back the stale-panel
// bug it was added for. Hence coalescing.
//
// This drives the real `AnnotecaPanelView` and stubs only `renderPanel`, so
// what is under test is the scheduler rather than the rendering. Rendering the
// hub for real needs a DOM plus the element helpers Obsidian injects, which is
// exactly the hand-written imitation `live-views.test.ts` argues against
// standing between a test and the thing it claims to verify.

import { AnnotecaPanelView, normalizeHubTab } from '../views';
import { DEFAULT_SETTINGS } from '../settings';
import type AnnotecaPlugin from '../main';
import type { WorkspaceLeaf } from 'obsidian';

// The private surface these tests reach for. `scheduleRefresh` and
// `renderPanel` are private to the view; a test is allowed to know about them,
// but the cast keeps that admission explicit and in one place.
interface HubInternals {
	scheduleRefresh(): void;
	renderPanel(): void;
}

function makeView(): {
	view: AnnotecaPanelView;
	internals: HubInternals;
	renders: () => number;
} {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS },
		// Only reached by onClose.
		clearActiveCommentHighlight: () => undefined,
	} as unknown as AnnotecaPlugin;

	const view = new AnnotecaPanelView({} as WorkspaceLeaf, plugin);
	// The mock ItemView has no contentEl; onClose is the only path here that
	// touches it, and only to empty it.
	(view as unknown as { contentEl: { empty(): void } }).contentEl = {
		empty: () => undefined,
	};

	let count = 0;
	const internals = view as unknown as HubInternals;
	// Own property, so it shadows the prototype method the scheduler calls.
	internals.renderPanel = () => {
		count += 1;
	};
	return { view, internals, renders: () => count };
}

// Lets the microtask the scheduler queued run. Queued after it, so it settles
// after it, and no timer is involved: this suite runs on testEnvironment "node"
// where there is no `window` for the timer helpers the plugin is required to
// use everywhere else.
const tick = (): Promise<void> =>
	new Promise((resolve) => queueMicrotask(resolve));

describe('hub refresh coalescing', () => {
	it('turns several triggers in one tick into a single render', async () => {
		const { internals, renders } = makeView();

		internals.scheduleRefresh();
		internals.scheduleRefresh();
		internals.scheduleRefresh();

		// Nothing has rendered yet: that deferral is what lets the second and
		// third trigger collapse into the first.
		expect(renders()).toBe(0);

		await tick();
		expect(renders()).toBe(1);
	});

	it('renders again for a trigger on a later tick', async () => {
		const { internals, renders } = makeView();

		internals.scheduleRefresh();
		await tick();
		expect(renders()).toBe(1);

		// Coalescing must not turn into "render once and never again".
		internals.scheduleRefresh();
		await tick();
		expect(renders()).toBe(2);
	});

	it('drops a queued render once the panel has closed', async () => {
		const { view, internals, renders } = makeView();

		internals.scheduleRefresh();
		await view.onClose();
		await tick();

		// onClose unloads the last render's markdown lifetime. A queued render
		// arriving afterwards would build a fresh Thread DOM and a fresh
		// lifetime against a panel that is gone.
		expect(renders()).toBe(0);
	});

	it('ignores triggers raised after close', async () => {
		const { view, internals, renders } = makeView();

		await view.onClose();
		internals.scheduleRefresh();
		await tick();

		expect(renders()).toBe(0);
	});
});

// The stored tab reaches four places: the switch that picks a renderer, the tab
// strip's active marker, and the starred-changed and scope-changed refresh
// guards. Falling back at the switch alone left the other three holding a value
// none of them recognise, so the panel drew Thread content with no tab lit and
// stopped refreshing on a scope change.
describe('views: normalizeHubTab', () => {
	it('keeps each tab the panel can actually draw', () => {
		expect(normalizeHubTab('thread')).toBe('thread');
		expect(normalizeHubTab('outline')).toBe('outline');
		expect(normalizeHubTab('starred')).toBe('starred');
	});

	it('sends anything else to thread', () => {
		for (const stored of [
			'garbage',
			'',
			null,
			undefined,
			42,
			{},
			[],
			'Thread',
		]) {
			expect(normalizeHubTab(stored)).toBe('thread');
		}
	});
});
