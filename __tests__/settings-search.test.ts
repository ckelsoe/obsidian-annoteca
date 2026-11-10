// Obsidian's settings search finds a setting by its name, description and
// aliases. A section drawn by hand has none of those unless it is given them,
// so every one of them except the footer must carry a name and be searchable.

import type { App } from 'obsidian';
import type AnnotecaPlugin from '../main';
import { AnnotecaSettingTab, DEFAULT_SETTINGS } from '../settings';

interface Item {
	type?: string;
	name?: string;
	desc?: unknown;
	searchable?: boolean;
	render?: unknown;
	items?: Item[];
}

function leaves(items: Item[]): Item[] {
	return items.flatMap((i) => (i.items ? leaves(i.items) : [i]));
}

describe('settings search', () => {
	const plugin = {
		settings: structuredClone(DEFAULT_SETTINGS),
	} as unknown as AnnotecaPlugin;
	const tab = new AnnotecaSettingTab({} as App, plugin);
	const items = leaves(tab.getSettingDefinitions() as unknown as Item[]);
	const custom = items.filter((i) => i.render !== undefined && !i.type);

	it('gives every hand-drawn section a name and makes it searchable, except the footer', () => {
		// Obsidian treats an absent `searchable` as true.
		const hidden = custom.filter((i) => i.searchable === false);
		expect(hidden).toHaveLength(1);
		for (const i of custom.filter((c) => c.searchable !== false)) {
			expect(i.name).not.toBe('');
			expect(typeof i.desc).toBe('string');
		}
	});

	it('finds the sections people look for by name', () => {
		const names = items.map((i) => i.name);
		for (const n of [
			'Export AI skill',
			'Task trigger words',
			'Category list',
			'Add category',
			'Collaborators and author colors',
		])
			expect(names).toContain(n);
	});
});
