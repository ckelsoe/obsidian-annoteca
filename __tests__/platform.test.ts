import { Platform } from 'obsidian';
import { isMobile, isPhone, supportsDragAndDrop } from '../platform';

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
		expect(supportsDragAndDrop()).toBe(true);
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
