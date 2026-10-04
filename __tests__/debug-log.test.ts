import type { App } from 'obsidian';

import {
	DEBUG_LOG_KEEP_CHARS,
	DEBUG_LOG_MAX_CHARS,
	DebugLog,
	elapsedMs,
	formatEntry,
	trimLog,
	type DebugSettings,
} from '../debug-log';

// An in-memory vault adapter with just the calls DebugLog makes.
function makeAdapter() {
	const files = new Map<string, string>();
	return {
		files,
		exists: (p: string) => Promise.resolve(files.has(p)),
		stat: (p: string) =>
			Promise.resolve(
				files.has(p) ? { size: files.get(p)?.length ?? 0 } : null,
			),
		read: (p: string) => Promise.resolve(files.get(p) ?? ''),
		write: (p: string, data: string) => {
			files.set(p, data);
			return Promise.resolve();
		},
		append: (p: string, data: string) => {
			files.set(p, (files.get(p) ?? '') + data);
			return Promise.resolve();
		},
	};
}

function makeLog(settings: DebugSettings) {
	const adapter = makeAdapter();
	const app = { vault: { adapter } } as unknown as App;
	const log = new DebugLog(app, 'config/plugins/annoteca', () => settings);
	return { log, adapter, settings };
}

describe('elapsedMs', () => {
	it('rounds to a tenth of a millisecond', () => {
		expect(elapsedMs(100, 112.345)).toBe(12.3);
		expect(elapsedMs(100, 100)).toBe(0);
	});
});

describe('formatEntry', () => {
	it('writes one JSON line with the time and event first', () => {
		const line = formatEntry(
			'rebuild',
			{ path: 'a.md', parseMs: 1.5 },
			new Date('2026-10-04T12:00:00.000Z'),
		);
		expect(line).toBe(
			'{"at":"2026-10-04T12:00:00.000Z","event":"rebuild","path":"a.md","parseMs":1.5}\n',
		);
	});
});

describe('trimLog', () => {
	it('leaves a log under the limit alone', () => {
		expect(trimLog('a\nb\n', 10)).toBe('a\nb\n');
	});

	it('keeps the newest entries and never starts mid-line', () => {
		const content = 'first entry\nsecond entry\nthird\n';
		// The last 12 characters start inside "second entry".
		expect(trimLog(content, 12)).toBe('third\n');
	});

	it('returns nothing when the kept part holds no complete line', () => {
		expect(trimLog('one very long line with no break', 5)).toBe('');
	});
});

describe('DebugLog', () => {
	it('does nothing while debug mode is off', async () => {
		const h = makeLog({ debugMode: false, debugLogTarget: 'vault' });
		h.log.log('rebuild', { path: 'a.md' });
		await h.log.flushed();
		expect(h.adapter.files.size).toBe(0);
		expect(h.log.enabled).toBe(false);
	});

	it('appends entries to debug.log in the plugin folder, in order', async () => {
		const h = makeLog({ debugMode: true, debugLogTarget: 'vault' });
		h.log.log('one');
		h.log.log('two', { n: 2 });
		await h.log.flushed();
		const text = h.adapter.files.get('config/plugins/annoteca/debug.log');
		const events = (text ?? '')
			.trimEnd()
			.split('\n')
			.map((l) => (JSON.parse(l) as { event: string }).event);
		expect(events).toEqual(['one', 'two']);
	});

	it('writes to the console, not a file, when that is the destination', async () => {
		const h = makeLog({ debugMode: true, debugLogTarget: 'console' });
		const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
		h.log.log('rebuild', { path: 'a.md' });
		await h.log.flushed();
		expect(h.adapter.files.size).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toContain('"event":"rebuild"');
		spy.mockRestore();
	});

	it('follows the setting live, without being rebuilt', async () => {
		const h = makeLog({ debugMode: false, debugLogTarget: 'vault' });
		h.log.log('ignored');
		h.settings.debugMode = true;
		h.log.log('kept');
		await h.log.flushed();
		expect(await h.log.read()).toContain('"event":"kept"');
		expect(await h.log.read()).not.toContain('ignored');
	});

	it('cuts the file back once it passes the cap, keeping the newest entries', async () => {
		const h = makeLog({ debugMode: true, debugLogTarget: 'vault' });
		// An existing file just under the cap, as left by an earlier session.
		const old = `${'x'.repeat(99)}\n`.repeat(DEBUG_LOG_MAX_CHARS / 100);
		h.adapter.files.set(h.log.path, old);
		h.log.log('newest');
		await h.log.flushed();
		const text = await h.log.read();
		expect(text.length).toBeLessThanOrEqual(DEBUG_LOG_KEEP_CHARS);
		expect(text.endsWith('\n')).toBe(true);
		expect(text).toContain('"event":"newest"');
	});

	it('reads an empty string when no log exists yet', async () => {
		const h = makeLog({ debugMode: true, debugLogTarget: 'vault' });
		expect(await h.log.read()).toBe('');
	});
});
