import { Platform } from 'obsidian';
import {
	isMobile,
	isPhone,
	canRequireNode,
	supportsDragAndDrop,
} from '../platform';

jest.mock('obsidian');

// The point of these tests is not that the wrappers return the right boolean,
// which is trivial. It is that they READ the object per call. Capturing
// `Platform.isMobile` at module load would still pass a naive test and would
// still be wrong on a tablet that gets re-docked, so every case here mutates
// the value after import.
describe('platform', () => {
	const original = { ...Platform };

	afterEach(() => {
		Object.assign(Platform, original);
	});

	it('reports desktop by default', () => {
		expect(isMobile()).toBe(false);
		expect(isPhone()).toBe(false);
		expect(canRequireNode()).toBe(true);
		expect(supportsDragAndDrop()).toBe(true);
	});

	// This is the guard the repo's "no top-level Node built-ins" rule depends
	// on. If it ever reported true without a Node runtime, a require('fs') would
	// run where no such module exists and take the plugin down at load.
	it('denies Node access on mobile', () => {
		Platform.isMobile = true;
		Platform.isDesktop = false;
		Platform.isDesktopApp = false;
		expect(canRequireNode()).toBe(false);
	});

	// The trap this helper exists to prevent. `Platform.isDesktop` only means
	// "the UI is in desktop mode"; `isDesktopApp` means "running under
	// Electron", and only the second implies Node. Desktop UI mode without the
	// Electron runtime must NOT be treated as Node-capable, so this pins the two
	// flags apart. Gating on isDesktop here would return true and crash.
	it('denies Node access in desktop UI mode that is not the Electron app', () => {
		Platform.isDesktop = true;
		Platform.isDesktopApp = false;
		expect(canRequireNode()).toBe(false);
	});

	it('follows isMobile changing after import', () => {
		Platform.isMobile = true;
		expect(isMobile()).toBe(true);
	});

	it('treats a tablet as mobile but not as a phone', () => {
		Platform.isMobile = true;
		Platform.isTablet = true;
		expect(isMobile()).toBe(true);
		expect(isPhone()).toBe(false);
	});

	it('treats a phone as both mobile and a phone', () => {
		Platform.isMobile = true;
		Platform.isPhone = true;
		expect(isMobile()).toBe(true);
		expect(isPhone()).toBe(true);
	});

	// The drag handle in category settings is rendered off this check. If it
	// ever inverts, mobile users get a grip that silently does nothing, which is
	// the exact bug this phase exists to remove.
	it('reports no drag-and-drop support on mobile', () => {
		Platform.isMobile = true;
		expect(supportsDragAndDrop()).toBe(false);
	});
});
