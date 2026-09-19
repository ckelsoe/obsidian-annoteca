// EXAMPLE ONLY. Not part of Annoteca, not bundled, and most users never need it.
//
// This shows how a SEPARATE Obsidian plugin consumes Annoteca's public API:
// detect a comment with no dependency, read comments, create them, and jump to
// one. Copy the parts you need into your own plugin. The full guide is in API.md.
//
// It is type-checked as part of this repo so it cannot drift from the real API,
// but it is excluded from the shipped bundle and the marketplace scan.

import { type App, type TFile, Notice } from 'obsidian';
import type { AnnotecaApi } from '../annoteca-api';

// `app.plugins` is an Obsidian internal the official types do not declare, so
// reach it through a minimal local shape rather than the official `App`.
interface PluginsRegistry {
	getPlugin(id: string): { api?: unknown } | null;
}

// Resolve at CALL time, never cache in your onload. Returns undefined when
// Annoteca is absent or older than the level you need, so callers degrade.
//
// This example gates on `>= 3` because it uses reveal(). Gate on the level YOUR
// integration needs: `>= 1` to read, `>= 2` to create, `>= 3` to reveal.
function annoteca(app: App): AnnotecaApi | undefined {
	const registry = (app as { plugins?: PluginsRegistry }).plugins;
	const api = registry?.getPlugin('annoteca')?.api as AnnotecaApi | undefined;
	return api && api.apiVersion >= 3 ? api : undefined;
}

// DETECT: tell that a block has a comment, with no dependency on Annoteca at all.
// Returns the category of each marker found in the block's text.
export function detectComments(blockText: string): string[] {
	const opener = /<!--\s*annoteca\/([a-z0-9-]+)\s*:/g;
	const categories: string[] = [];
	for (const match of blockText.matchAll(opener)) {
		const category = match[1];
		if (category !== undefined) {
			categories.push(category);
		}
	}
	return categories;
}

// READ: open comments for a file, where their prose sits in the text you pass,
// and the user's own categories. Returns a small summary so every field is used.
export async function readComments(
	app: App,
	file: TFile,
	editorText: string,
): Promise<{ labels: string[]; quoted: string[]; categoryNames: string[] }> {
	const api = annoteca(app);
	if (api === undefined) {
		return { labels: [], quoted: [], categoryNames: [] }; // Annoteca absent
	}
	const open = await api.queryComments({ paths: [file.path] });
	const labels = open.map(
		(c) =>
			`${c.category}: ${c.body} (${String(c.replyCount)} replies, ${c.resolved ? 'resolved' : 'open'})`,
	);
	// anchorsFor is pure over its input: pass the LIVE editor text, not the disk
	// copy, or unsaved edits move every offset.
	const quoted = api
		.anchorsFor(editorText)
		.map((r) => editorText.slice(r.start, r.end));
	const categoryNames = api.categories().map((cat) => cat.displayName);
	return { labels, quoted, categoryNames };
}

// REACT: re-render when comments change. Returns the unsubscribe; call it on
// unload, or the callback outlives your plugin. Undefined when Annoteca is absent.
export function watchComments(
	app: App,
	onChange: () => void,
): (() => void) | undefined {
	return annoteca(app)?.onChange(onChange);
}

// CREATE: turn your own finding into a comment. Idempotent on author:sourceKey,
// so running twice over the same finding does not duplicate it. Returns whether a
// comment was actually written.
export async function createComment(
	app: App,
	file: TFile,
	expected: string,
	start: number,
	end: number,
): Promise<boolean> {
	const api = annoteca(app);
	if (api === undefined) {
		return false;
	}
	const created = await api.promote(
		file.path,
		[
			{
				category: 'clarify',
				body: 'Which products does this cover?',
				anchor: { start, end },
				author: 'your-plugin-id',
				sourceKey: 'your-stable-key-for-this-finding',
			},
		],
		// The exact text the offsets were computed against. If the note moved on,
		// promote returns [] rather than writing to the wrong place; re-read and retry.
		expected,
	);
	return created.length > 0;
}

// REVEAL: jump to a comment from your own indicator. false when no comment has
// that id (it may have been deleted since you read it).
export async function revealComment(
	app: App,
	commentId: string,
): Promise<void> {
	const api = annoteca(app);
	if (api === undefined) {
		new Notice('Annoteca is not available.');
		return;
	}
	const found = await api.reveal(commentId);
	if (!found) {
		new Notice('That comment no longer exists.');
	}
}
