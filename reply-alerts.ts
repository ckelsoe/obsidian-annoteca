// Reply alerts: a popup and a sound when someone other than the user adds a
// comment or replies to one, for example an AI agent answering the user's
// comments from outside Obsidian. Off by default.
//
// Built on the per-comment events (comment-events.ts), so an alert arrives
// only after a note's changes settle, a few seconds after the write. Bursts
// are grouped twice: the event flush already merges a burst of writes, and
// the cooldown here merges flushes that land close together, so an agent
// answering twenty comments in a row gives a handful of alerts, not twenty.
//
// "Someone other than the user" is decided by author tag, the only identity
// the note records. An agent writing under the user's own tag cannot be told
// apart, and a comment with no author tag never alerts: there is nobody to
// attribute it to, and comments the user types without a tag have none.

import { Notice, type App, type TFile } from 'obsidian';
import type { CommentEvent } from './comment-events';
import type { AnnotecaSettings } from './types';

export type AlertPopup = 'off' | 'notice' | 'system' | 'both';
export type AlertTone = 'chime' | 'ping' | 'pop';

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

// What Chromium's media stack plays. AIFF, the macOS system-sound format, is
// missing on purpose: it fails to load in Obsidian (checked live, 2026-10-15).
const ALERT_AUDIO_EXTENSIONS: readonly string[] = [
	'wav',
	'mp3',
	'ogg',
	'm4a',
	'flac',
	'webm',
];

// Flushes landing within this long of an alert are held and given as one
// alert when it ends.
export const ALERT_COOLDOWN_MS = 30_000;

// Whether alerts are on at all, which decides whether the vault has to be
// indexed for events. A system sound with no system popup plays nothing, so
// it does not count.
export function alertsEnabled(s: AlertSettings): boolean {
	return (
		s.replyAlertPopup !== 'off' ||
		s.replyAlertSound === 'file' ||
		s.replyAlertSound === 'tone'
	);
}

export function popupIncludesSystem(popup: AlertPopup): boolean {
	return popup === 'system' || popup === 'both';
}

// The tags the user's own writing carries: the author tag when it is on, and
// `user`, which Annoteca writes when it is off. Both always, because a note
// keeps whatever was written before the user last changed that setting.
// Lowercased: the parser accepts mixed-case tags.
export function selfTags(s: AlertSettings): Set<string> {
	const tags = new Set(['user']);
	const tag = s.authorTag.trim();
	if (tag !== '') tags.add(tag.toLowerCase());
	return tags;
}

// Someone else commented or replied. A created event for a comment another
// plugin promoted is left out: the user ran that plugin, so it is their own
// work arriving, not someone answering them. A reply to such a comment still
// alerts.
export function isAlertEvent(
	e: CommentEvent,
	self: ReadonlySet<string>,
): boolean {
	if (e.type !== 'created' && e.type !== 'replied') return false;
	if (e.author === undefined || self.has(e.author.toLowerCase()))
		return false;
	return !(e.type === 'created' && e.source !== undefined);
}

export interface AlertText {
	readonly title: string;
	readonly body: string;
	// The newest comment in the alert, opened when the popup is clicked.
	readonly target: { readonly id: string; readonly path: string } | undefined;
}

// "kilo replied in Chapter 3", or for several, "4 new replies from kilo in 2
// notes". `noteName` turns a path into what the user calls the note.
export function describeAlert(
	events: readonly CommentEvent[],
	noteName: (path: string) => string,
): AlertText {
	const last = events[events.length - 1];
	const target =
		last?.id !== undefined && last.path !== undefined
			? { id: last.id, path: last.path }
			: undefined;
	if (events.length === 1 && last !== undefined) {
		const verb = last.type === 'replied' ? 'replied' : 'commented';
		return {
			title: 'Annoteca',
			body: `${last.author ?? 'Someone'} ${verb} in ${noteName(last.path ?? '')}`,
			target,
		};
	}
	const replies = events.filter((e) => e.type === 'replied').length;
	const kind =
		replies === events.length
			? 'replies'
			: replies === 0
				? 'comments'
				: 'comments and replies';
	const authors = new Set(events.map((e) => e.author));
	const [only] = authors;
	const from =
		authors.size === 1 && only !== undefined ? ` from ${only}` : '';
	const notes = new Set(events.map((e) => e.path)).size;
	const where = notes === 1 ? 'in 1 note' : `in ${notes} notes`;
	return {
		title: 'Annoteca',
		body: `${events.length} new ${kind}${from} ${where}`,
		target,
	};
}

// Gives the first batch straight away, then holds anything that arrives
// during the cooldown and gives it as one batch when the cooldown ends, which
// starts another.
export class AlertCooldown {
	private timer: number | undefined;
	private held: CommentEvent[] = [];

	constructor(
		private readonly emit: (events: readonly CommentEvent[]) => void,
		private readonly cooldownMs: number,
	) {}

	push(events: readonly CommentEvent[]): void {
		if (events.length === 0) return;
		if (this.timer !== undefined) {
			this.held.push(...events);
			return;
		}
		this.emit(events);
		this.start();
	}

	cancel(): void {
		if (this.timer !== undefined) window.clearTimeout(this.timer);
		this.timer = undefined;
		this.held = [];
	}

	private start(): void {
		this.timer = window.setTimeout(() => {
			this.timer = undefined;
			if (this.held.length === 0) return;
			const batch = this.held;
			this.held = [];
			this.emit(batch);
			this.start();
		}, this.cooldownMs);
	}
}

// One sine (or other wave) note of a tone, in seconds from the tone's start.
// `glideTo` slides the pitch over the note, which is what makes a pop.
export interface ToneNote {
	readonly freq: number;
	readonly glideTo?: number;
	readonly start: number;
	readonly duration: number;
	readonly wave: OscillatorType;
}

// Generated rather than shipped: a release carries only main.js,
// manifest.json and styles.css, so there is nowhere to put a sound file.
export const TONES: Readonly<Record<AlertTone, readonly ToneNote[]>> = {
	// A rising fifth, A5 then E6, the second overlapping the first.
	chime: [
		{ freq: 880, start: 0, duration: 0.5, wave: 'sine' },
		{ freq: 1318.51, start: 0.12, duration: 0.7, wave: 'sine' },
	],
	// One short high note.
	ping: [{ freq: 1567.98, start: 0, duration: 0.35, wave: 'sine' }],
	// A fast downward slide.
	pop: [{ freq: 520, glideTo: 180, start: 0, duration: 0.09, wave: 'sine' }],
};

// Generated tones are pure waves, far louder than a typical sound file at
// the same volume setting, so they are scaled down to sit beside one.
const TONE_HEADROOM = 0.35;

// How each part of an alert is delivered. Separate from the decisions so the
// decisions can be tested without a browser, and replaced in tests.
export interface AlertOutputs {
	notice(text: string, onClick: (() => void) | undefined): void;
	// False when the system popup could not be shown (no Notification
	// support, permission not granted), so the caller can fall back.
	system(
		title: string,
		body: string,
		silent: boolean,
		onClick: (() => void) | undefined,
	): boolean;
	// `onFail` gets a sentence for the user when the sound cannot play.
	playFile(path: string, volume: number, onFail: (why: string) => void): void;
	playTone(
		tone: AlertTone,
		volume: number,
		onFail: (why: string) => void,
	): void;
	dispose(): void;
}

export class ReplyAlerts {
	private readonly cooldown = new AlertCooldown(
		(events) => this.alert(events),
		ALERT_COOLDOWN_MS,
	);
	private disposed = false;
	// A sound that fails on a real alert is reported once a session: on iOS
	// it can fail on every alert until the user taps in the app.
	private soundFailureShown = false;

	constructor(
		private readonly settings: () => AlertSettings,
		private readonly noteName: (path: string) => string,
		private readonly open: (id: string) => void,
		private readonly outputs: AlertOutputs,
	) {}

	// Every settled batch of comment events comes through here.
	push(events: readonly CommentEvent[]): void {
		if (this.disposed) return;
		const s = this.settings();
		if (!alertsEnabled(s)) return;
		const self = selfTags(s);
		this.cooldown.push(events.filter((e) => isAlertEvent(e, self)));
	}

	// The settings tab's test button: one alert as if someone had replied,
	// with nothing to open.
	test(): void {
		this.alert([{ type: 'replied', author: 'someone', path: 'a note' }]);
	}

	// The user asked to hear it, so every failure is reported.
	previewSound(): void {
		this.playSound(this.settings(), (why) =>
			this.outputs.notice(`Annoteca: ${why}`, undefined),
		);
	}

	dispose(): void {
		this.disposed = true;
		this.cooldown.cancel();
		this.outputs.dispose();
	}

	private alert(events: readonly CommentEvent[]): void {
		if (this.disposed) return;
		const s = this.settings();
		const text = describeAlert(events, this.noteName);
		const { target } = text;
		const onClick =
			target === undefined ? undefined : (): void => this.open(target.id);
		let notice =
			s.replyAlertPopup === 'notice' || s.replyAlertPopup === 'both';
		if (popupIncludesSystem(s.replyAlertPopup)) {
			// Silent unless the OS sound is the chosen one, so two sounds
			// never play together.
			const shown = this.outputs.system(
				text.title,
				text.body,
				s.replyAlertSound !== 'system',
				onClick,
			);
			// No system popup here (mobile, or permission not granted): the
			// notice instead, rather than no popup at all.
			if (!shown) notice = true;
		}
		if (notice) this.outputs.notice(`Annoteca: ${text.body}`, onClick);
		this.playSound(s, (why) => {
			if (this.disposed || this.soundFailureShown) return;
			this.soundFailureShown = true;
			this.outputs.notice(`Annoteca: ${why}`, undefined);
		});
	}

	private playSound(s: AlertSettings, onFail: (why: string) => void): void {
		const volume = Math.min(100, Math.max(0, s.replyAlertVolume)) / 100;
		// Zero is off. An exponential envelope cannot reach zero, so a tone
		// at volume 0 would still be faintly audible.
		if (volume === 0) return;
		if (s.replyAlertSound === 'file') {
			if (s.replyAlertSoundFile === '')
				onFail('choose a sound file for reply alerts in settings.');
			else this.outputs.playFile(s.replyAlertSoundFile, volume, onFail);
		} else if (s.replyAlertSound === 'tone') {
			this.outputs.playTone(s.replyAlertTone, volume, onFail);
		}
	}
}

export function isAlertAudioFile(file: TFile): boolean {
	return ALERT_AUDIO_EXTENSIONS.includes(file.extension.toLowerCase());
}

// The real outputs: Obsidian's Notice, the HTML Notification (which Obsidian's
// desktop app shows as an OS notification), an Audio element for a vault
// file, and Web Audio for the tones.
export function browserAlertOutputs(
	app: App,
	systemAvailable: () => boolean,
): AlertOutputs {
	let ctx: AudioContext | undefined;
	let audio: HTMLAudioElement | undefined;
	let disposed = false;
	let permissionAsked = false;
	// Still on screen, so unload can take them down: a click on one after
	// the plugin is gone would run the old instance's navigation.
	const notices = new Set<Notice>();
	const notifications = new Set<Notification>();
	return {
		notice(text, onClick): void {
			const notice = new Notice(text, 8000);
			if (onClick === undefined) return;
			notices.add(notice);
			window.setTimeout(() => notices.delete(notice), 8000);
			notice.messageEl.addClass('annoteca-alert-notice');
			notice.messageEl.addEventListener('click', () => {
				notice.hide();
				notices.delete(notice);
				if (!disposed) onClick();
			});
		},
		system(title, body, silent, onClick): boolean {
			if (!systemAvailable()) return false;
			if (Notification.permission !== 'granted') {
				// Asked once a session, never again after a refusal; this
				// alert falls back to the notice.
				if (Notification.permission === 'default' && !permissionAsked) {
					permissionAsked = true;
					Notification.requestPermission().catch((err: unknown) => {
						console.error(
							'Annoteca: notification permission request failed',
							err,
						);
					});
				}
				return false;
			}
			const n = new Notification(title, { body, silent });
			notifications.add(n);
			n.onclose = (): void => {
				notifications.delete(n);
			};
			n.onclick = (): void => {
				n.close();
				if (disposed) return;
				window.focus();
				onClick?.();
			};
			return true;
		},
		playFile(path, volume, onFail): void {
			const file = app.vault.getFileByPath(path);
			if (file === null) {
				onFail(`the alert sound file ${path} was not found.`);
				return;
			}
			audio?.pause();
			const el = new Audio(app.vault.getResourcePath(file));
			audio = el;
			el.volume = volume;
			el.play().catch((err: unknown) => {
				// Pausing it for a newer sound, or for unload, is not a failure.
				if (audio !== el) return;
				console.error('Annoteca: alert sound did not play', err);
				// iOS refuses until the user has tapped in the app; a format
				// Chromium cannot decode refuses too.
				onFail(`the alert sound ${file.name} did not play.`);
			});
		},
		playTone(tone, volume, onFail): void {
			if (disposed) return;
			ctx ??= new AudioContext();
			const context = ctx;
			const play = (): void => {
				const t0 = context.currentTime + 0.01;
				const peak = volume * TONE_HEADROOM;
				for (const note of TONES[tone]) {
					const osc = context.createOscillator();
					const gain = context.createGain();
					const start = t0 + note.start;
					const end = start + note.duration;
					osc.type = note.wave;
					osc.frequency.setValueAtTime(note.freq, start);
					if (note.glideTo !== undefined)
						osc.frequency.exponentialRampToValueAtTime(
							note.glideTo,
							end,
						);
					gain.gain.setValueAtTime(0.0001, start);
					gain.gain.exponentialRampToValueAtTime(peak, start + 0.005);
					gain.gain.exponentialRampToValueAtTime(0.0001, end);
					osc.connect(gain).connect(context.destination);
					osc.start(start);
					osc.stop(end + 0.02);
				}
			};
			// A context made before the user has interacted starts suspended
			// on some platforms (iOS); resume is a no-op when it is running.
			context
				.resume()
				.then(() => {
					// Unloaded while resuming: the context is closed.
					if (disposed || ctx !== context) return;
					play();
				})
				.catch((err: unknown) => {
					console.error('Annoteca: alert tone did not play', err);
					onFail('the alert tone did not play.');
				});
		},
		dispose(): void {
			disposed = true;
			for (const n of notices) n.hide();
			notices.clear();
			for (const n of notifications) n.close();
			notifications.clear();
			audio?.pause();
			audio = undefined;
			ctx?.close().catch((err: unknown) => {
				console.error('Annoteca: closing the alert audio failed', err);
			});
			ctx = undefined;
		},
	};
}
