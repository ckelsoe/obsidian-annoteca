import { TFile } from "obsidian";

import type AnnotecaPlugin from "../main";
import { CommentService } from "../comment-service";
import { parseAll } from "../parser";

const NOTE = [
	"Prose under review. <!-- annoteca/clarify: which products?",
	"[id=a1b2c3d4]",
	"-->",
	"",
	"More prose.",
].join("\n");

// Stub plugin exercising the closed-file write path (no markdown leaves →
// vault.modify). The editor path shares applySplices and is validated by hand.
function makeHarness(deleteOnResolve: boolean) {
	let content = NOTE;
	const file = new TFile();
	const plugin = {
		settings: {
			enableAuthorTag: true,
			authorTag: "charles",
			deleteOnResolve,
		},
		app: {
			vault: {
				getAbstractFileByPath: () => file,
				read: () => Promise.resolve(content),
				modify: (_file: TFile, updated: string) => {
					content = updated;
					return Promise.resolve();
				},
			},
			workspace: {
				getLeavesOfType: () => [],
				getActiveFile: () => null,
			},
		},
		commentIndex: { rebuild: () => undefined },
		events: { trigger: () => undefined },
	} as unknown as AnnotecaPlugin;
	return {
		service: new CommentService(plugin),
		get content() { return content; },
	};
}

function firstComment(content: string) {
	const comments = parseAll(content);
	expect(comments).toHaveLength(1);
	const c = comments[0];
	if (!c) throw new Error("no comment parsed");
	return c;
}

describe("resolveComment with delete-on-resolve off", () => {
	it("keeps the marker and appends a [resolved ...] line", async () => {
		const h = makeHarness(false);
		await h.service.resolveComment("note.md", firstComment(h.content));
		const after = parseAll(h.content);
		expect(after).toHaveLength(1);
		expect(after[0]?.resolution?.author).toBe("charles");
		expect(h.content).toContain("annoteca/clarify");
	});

	it("is a no-op on an already-resolved comment", async () => {
		const h = makeHarness(false);
		await h.service.resolveComment("note.md", firstComment(h.content));
		const before = h.content;
		await h.service.resolveComment("note.md", firstComment(h.content));
		expect(h.content).toBe(before);
	});
});

describe("resolveComment with delete-on-resolve on", () => {
	it("removes the marker entirely", async () => {
		const h = makeHarness(true);
		await h.service.resolveComment("note.md", firstComment(h.content));
		expect(parseAll(h.content)).toHaveLength(0);
		expect(h.content).not.toContain("annoteca");
		// The prose itself survives.
		expect(h.content).toContain("Prose under review.");
		expect(h.content).toContain("More prose.");
	});
});

describe("resolveAndRemoveComment", () => {
	it("removes the marker regardless of the toggle", async () => {
		const h = makeHarness(false);
		await h.service.resolveAndRemoveComment("note.md", firstComment(h.content));
		expect(parseAll(h.content)).toHaveLength(0);
		expect(h.content).toContain("Prose under review.");
	});
});
