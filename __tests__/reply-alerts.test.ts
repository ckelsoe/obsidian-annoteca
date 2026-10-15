/**
 * @jest-environment jsdom
 */
import type { CommentEvent } from '../comment-events';
import {
	ALERT_COOLDOWN_MS,
	AlertCooldown,
	ReplyAlerts,
	TONES,
	alertsEnabled,
	describeAlert,
	isAlertEvent,
	selfTags,
	type AlertOutputs,
} from '../reply-alerts';
import { normalizeSettings } from '../settings';
import type { AnnotecaSettings } from '../types';

type AlertSettings = Pick<
	AnnotecaSettings,
	| 'replyAlertPopup'
	| 'replyAlertSound'
	| 'replyAlertSoundFile'
	| 'replyAlertTone'
	| 'replyAlertVolume'
	| 'enableAuthorTag'
	| 'authorTag'
>;

function settings(over: Partial<AlertSettings> = {}): AlertSettings {
	return {
		replyAlertPopup: 'notice',
		replyAlertSound: 'none',
		replyAlertSoundFile: '',
		replyAlertTone: 'chime',
		replyAlertVolume: 70,
		enableAuthorTag: true,
		authorTag: 'ed',
		...over,
	};
}

function reply(
	author: string | undefined,
	path = 'Ch1.md',
	id = 'c1',
): CommentEvent {
	return {
		type: 'replied',
		id,
		path,
		category: 'clarify',
		...(author !== undefined && { author }),
	};
}

function created(author: string, path = 'Ch1.md', id = 'c2'): CommentEvent {
	return { type: 'created', id, path, category: 'clarify', author };
}

const name = (path: string): string => path.replace(/\.md$/, '');

describe('which events alert', () => {
	const self = selfTags(settings());

	it('alerts on a reply or a new comment by someone else', () => {
		expect(isAlertEvent(reply('kilo'), self)).toBe(true);
		expect(isAlertEvent(created('kilo'), self)).toBe(true);
	});

	it('never alerts on the user, by tag or as user, in any case', () => {
		expect(isAlertEvent(reply('ed'), self)).toBe(false);
		expect(isAlertEvent(reply('Ed'), self)).toBe(false);
		expect(isAlertEvent(reply('user'), self)).toBe(false);
		expect(isAlertEvent(created('ED'), self)).toBe(false);
	});

	it('treats the stored tag as the user even with the author tag off', () => {
		const off = selfTags(settings({ enableAuthorTag: false }));
		expect(off.has('ed')).toBe(true);
		expect(off.has('user')).toBe(true);
	});

	it('skips an event with no author', () => {
		expect(isAlertEvent(reply(undefined), self)).toBe(false);
	});

	it('skips every other event type', () => {
		for (const type of [
			'addressed',
			'resolved',
			'reopened',
			'moved',
			'deleted',
		] as const) {
			expect(
				isAlertEvent(
					{ type, id: 'c1', path: 'a.md', author: 'kilo' },
					self,
				),
			).toBe(false);
		}
		expect(isAlertEvent({ type: 'resync', reason: 'scan' }, self)).toBe(
			false,
		);
	});

	it('skips a comment another plugin promoted, but not a reply to it', () => {
		const source = { tag: 'plumbline', key: 'k1' };
		expect(isAlertEvent({ ...created('plumbline'), source }, self)).toBe(
			false,
		);
		expect(isAlertEvent({ ...reply('kilo'), source }, self)).toBe(true);
	});
});

describe('alertsEnabled', () => {
	it('is off by default', () => {
		expect(alertsEnabled(normalizeSettings({}))).toBe(false);
	});

	it('is on for any popup, or a sound Annoteca plays itself', () => {
		expect(alertsEnabled(settings({ replyAlertPopup: 'system' }))).toBe(
			true,
		);
		expect(
			alertsEnabled(
				settings({ replyAlertPopup: 'off', replyAlertSound: 'tone' }),
			),
		).toBe(true);
		expect(
			alertsEnabled(
				settings({ replyAlertPopup: 'off', replyAlertSound: 'file' }),
			),
		).toBe(true);
	});

	it('is off for a system sound with no popup to play it', () => {
		expect(
			alertsEnabled(
				settings({ replyAlertPopup: 'off', replyAlertSound: 'system' }),
			),
		).toBe(false);
	});
});

describe('describeAlert', () => {
	it('names the author and note for one event', () => {
		expect(describeAlert([reply('kilo')], name).body).toBe(
			'kilo replied in Ch1',
		);
		expect(describeAlert([created('kilo')], name).body).toBe(
			'kilo commented in Ch1',
		);
	});

	it('counts several, naming a single author', () => {
		const text = describeAlert(
			[reply('kilo', 'a.md', 'x'), reply('kilo', 'b.md', 'y')],
			name,
		);
		expect(text.body).toBe('2 new replies from kilo in 2 notes');
		expect(text.target).toEqual({ id: 'y', path: 'b.md' });
	});

	it('drops the author when several wrote, and names a mix', () => {
		expect(describeAlert([reply('kilo'), created('ana')], name).body).toBe(
			'2 new comments and replies in 1 note',
		);
		expect(
			describeAlert([created('kilo'), created('ana')], name).body,
		).toBe('2 new comments in 1 note');
	});
});

describe('AlertCooldown', () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it('gives the first batch at once and holds the rest until the cooldown ends', () => {
		const emitted: CommentEvent[][] = [];
		const cd = new AlertCooldown((e) => emitted.push([...e]), 1000);
		cd.push([reply('kilo', 'a.md', '1')]);
		cd.push([reply('kilo', 'a.md', '2')]);
		cd.push([reply('kilo', 'a.md', '3')]);
		expect(emitted.map((b) => b.length)).toEqual([1]);
		jest.advanceTimersByTime(1000);
		expect(emitted.map((b) => b.length)).toEqual([1, 2]);
		// The held batch started a new cooldown.
		cd.push([reply('kilo', 'a.md', '4')]);
		expect(emitted).toHaveLength(2);
		jest.advanceTimersByTime(1000);
		expect(emitted).toHaveLength(3);
	});

	it('ignores empty batches and emits at once after a quiet cooldown', () => {
		const emitted: CommentEvent[][] = [];
		const cd = new AlertCooldown((e) => emitted.push([...e]), 1000);
		cd.push([]);
		expect(emitted).toHaveLength(0);
		cd.push([reply('kilo')]);
		jest.advanceTimersByTime(1000);
		cd.push([reply('kilo')]);
		expect(emitted).toHaveLength(2);
	});

	it('drops held events on cancel', () => {
		const emitted: CommentEvent[][] = [];
		const cd = new AlertCooldown((e) => emitted.push([...e]), 1000);
		cd.push([reply('kilo')]);
		cd.push([reply('kilo')]);
		cd.cancel();
		jest.advanceTimersByTime(5000);
		expect(emitted).toHaveLength(1);
	});
});

describe('ReplyAlerts routing', () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	function rig(s: AlertSettings, systemShown = true, soundFails = false) {
		const calls: string[] = [];
		const opened: string[] = [];
		let click: (() => void) | undefined;
		const outputs: AlertOutputs = {
			notice: (text, onClick) => {
				calls.push(`notice:${text}`);
				click = onClick;
			},
			system: (_title, body, silent) => {
				calls.push(`system:${body}:${silent ? 'silent' : 'sound'}`);
				return systemShown;
			},
			playFile: (path, volume, onFail) => {
				calls.push(`file:${path}:${volume}`);
				if (soundFails) onFail('it failed.');
			},
			playTone: (tone, volume, onFail) => {
				calls.push(`tone:${tone}:${volume}`);
				if (soundFails) onFail('it failed.');
			},
			dispose: () => calls.push('dispose'),
		};
		const alerts = new ReplyAlerts(
			() => s,
			name,
			(id) => opened.push(id),
			outputs,
		);
		return { alerts, calls, opened, click: () => click?.() };
	}

	it('shows the notice and opens the comment on click', () => {
		const r = rig(settings());
		r.alerts.push([reply('kilo')]);
		expect(r.calls).toEqual(['notice:Annoteca: kilo replied in Ch1']);
		r.click();
		expect(r.opened).toEqual(['c1']);
	});

	it('does nothing for the user or when off', () => {
		const r = rig(settings());
		r.alerts.push([reply('ed'), { type: 'resync', reason: 'scan' }]);
		const off = rig(settings({ replyAlertPopup: 'off' }));
		off.alerts.push([reply('kilo')]);
		expect([...r.calls, ...off.calls]).toEqual([]);
	});

	it('sends the system popup with sound only for the system sound', () => {
		const sys = rig(
			settings({ replyAlertPopup: 'system', replyAlertSound: 'system' }),
		);
		sys.alerts.push([reply('kilo')]);
		expect(sys.calls).toEqual(['system:kilo replied in Ch1:sound']);

		const tone = rig(
			settings({ replyAlertPopup: 'both', replyAlertSound: 'tone' }),
		);
		tone.alerts.push([reply('kilo')]);
		expect(tone.calls).toEqual([
			'system:kilo replied in Ch1:silent',
			'notice:Annoteca: kilo replied in Ch1',
			'tone:chime:0.7',
		]);
	});

	it('falls back to the notice when no system popup can be shown', () => {
		const r = rig(settings({ replyAlertPopup: 'system' }), false);
		r.alerts.push([reply('kilo')]);
		expect(r.calls).toEqual([
			'system:kilo replied in Ch1:silent',
			'notice:Annoteca: kilo replied in Ch1',
		]);
	});

	it('plays the vault file at the set volume, with no popup', () => {
		const r = rig(
			settings({
				replyAlertPopup: 'off',
				replyAlertSound: 'file',
				replyAlertSoundFile: 'Sounds/ding.mp3',
				replyAlertVolume: 40,
			}),
		);
		r.alerts.push([reply('kilo')]);
		expect(r.calls).toEqual(['file:Sounds/ding.mp3:0.4']);
	});

	it('says so when previewing a file sound with no file chosen', () => {
		const r = rig(settings({ replyAlertSound: 'file' }));
		r.alerts.previewSound();
		expect(r.calls).toEqual([
			'notice:Annoteca: choose a sound file for reply alerts in settings.',
		]);
	});

	it('plays nothing at volume 0', () => {
		const r = rig(
			settings({
				replyAlertPopup: 'off',
				replyAlertSound: 'tone',
				replyAlertVolume: 0,
			}),
		);
		r.alerts.previewSound();
		r.alerts.push([reply('kilo')]);
		expect(r.calls).toEqual([]);
	});

	it('reports a failed preview every time', () => {
		const r = rig(settings({ replyAlertSound: 'tone' }), true, true);
		r.alerts.previewSound();
		r.alerts.previewSound();
		expect(r.calls.filter((c) => c.includes('it failed'))).toHaveLength(2);
	});

	it('reports a sound failing on real alerts once a session', () => {
		const r = rig(
			settings({ replyAlertPopup: 'off', replyAlertSound: 'tone' }),
			true,
			true,
		);
		r.alerts.push([reply('kilo')]);
		jest.advanceTimersByTime(ALERT_COOLDOWN_MS);
		r.alerts.push([reply('kilo')]);
		expect(r.calls).toEqual([
			'tone:chime:0.7',
			'notice:Annoteca: it failed.',
			'tone:chime:0.7',
		]);
	});

	it('groups a burst into one alert and one sound', () => {
		const r = rig(settings({ replyAlertSound: 'tone' }));
		r.alerts.push([reply('kilo', 'a.md', '1')]);
		r.alerts.push([reply('kilo', 'a.md', '2')]);
		r.alerts.push([reply('kilo', 'b.md', '3')]);
		jest.advanceTimersByTime(ALERT_COOLDOWN_MS);
		expect(r.calls).toEqual([
			'notice:Annoteca: kilo replied in a',
			'tone:chime:0.7',
			'notice:Annoteca: 2 new replies from kilo in 2 notes',
			'tone:chime:0.7',
		]);
	});

	it('is silent after dispose, including for held events', () => {
		const r = rig(settings());
		r.alerts.push([reply('kilo')]);
		r.alerts.push([reply('kilo')]);
		r.alerts.dispose();
		r.alerts.push([reply('kilo')]);
		jest.advanceTimersByTime(ALERT_COOLDOWN_MS);
		expect(r.calls).toEqual([
			'notice:Annoteca: kilo replied in Ch1',
			'dispose',
		]);
	});

	it('test() alerts with nothing to open', () => {
		const r = rig(settings());
		r.alerts.test();
		r.click();
		expect(r.calls).toHaveLength(1);
		expect(r.opened).toEqual([]);
	});
});

describe('settings', () => {
	it('defaults to off and repairs bad values', () => {
		const s = normalizeSettings({
			replyAlertPopup: 'loud',
			replyAlertSound: 'system',
			replyAlertVolume: 140,
			replyAlertTone: 'ping',
		});
		expect(s.replyAlertPopup).toBe('off');
		expect(s.replyAlertSound).toBe('system');
		expect(s.replyAlertVolume).toBe(70);
		expect(s.replyAlertTone).toBe('ping');
		expect(
			normalizeSettings({ replyAlertVolume: 33.4 }).replyAlertVolume,
		).toBe(33);
	});
});

describe('TONES', () => {
	it('every tone has notes with positive pitch and length', () => {
		for (const notes of Object.values(TONES)) {
			expect(notes.length).toBeGreaterThan(0);
			for (const n of notes) {
				expect(n.freq).toBeGreaterThan(0);
				expect(n.duration).toBeGreaterThan(0);
				expect(n.start).toBeGreaterThanOrEqual(0);
				if (n.glideTo !== undefined)
					expect(n.glideTo).toBeGreaterThan(0);
			}
		}
	});
});
