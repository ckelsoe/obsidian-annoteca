import { rgbStringToHex } from "../ui-helpers";
import { extractIndexTerm, bucketCommentsByHeading } from "../view-utils";
import { computeScopeFileSet, type ScopeFile } from "../scope";
import type { Comment, ScopeShape } from "../types";

describe("rgbStringToHex", () => {
	it("converts standard rgb() to lower-case 6-digit hex", () => {
		expect(rgbStringToHex("rgb(255, 128, 0)")).toBe("#ff8000");
	});

	it("handles rgb() without spaces", () => {
		expect(rgbStringToHex("rgb(0,0,0)")).toBe("#000000");
	});

	it("ignores the alpha channel on rgba()", () => {
		expect(rgbStringToHex("rgba(15, 200, 100, 0.5)")).toBe("#0fc864");
	});

	it("clamps high channels to 255 and treats stray '-' as a separator", () => {
		// The regex matches \d+, so '-5' becomes '5'; '300' clamps to 'ff'.
		// Browsers never emit negative components, so this quirk is moot in
		// practice; the test pins the actual behavior.
		expect(rgbStringToHex("rgb(300, -5, 128)")).toBe("#ff0580");
	});

	it("rounds fractional channels", () => {
		expect(rgbStringToHex("rgb(127.5, 127.5, 127.5)")).toBe("#808080");
	});

	it("returns undefined on 'transparent'", () => {
		expect(rgbStringToHex("transparent")).toBeUndefined();
	});

	it("returns undefined on an empty string", () => {
		expect(rgbStringToHex("")).toBeUndefined();
	});

	it("returns undefined when fewer than three numbers parse out", () => {
		expect(rgbStringToHex("rgb(10)")).toBeUndefined();
	});
});

describe("extractIndexTerm", () => {
	it("returns the body unchanged when no em-dash is present", () => {
		expect(extractIndexTerm("Topic")).toBe("Topic");
	});

	it("preserves a term > subterm chain", () => {
		expect(extractIndexTerm("Topic > Sub")).toBe("Topic > Sub");
	});

	it("strips the post-em-dash body from a flat term", () => {
		expect(extractIndexTerm("Topic — body text")).toBe("Topic");
	});

	it("strips the post-em-dash body from a term > subterm chain", () => {
		expect(extractIndexTerm("Topic > Sub — body text")).toBe("Topic > Sub");
	});

	it("returns '(unspecified)' for empty input", () => {
		expect(extractIndexTerm("")).toBe("(unspecified)");
	});

	it("returns '(unspecified)' for whitespace-only input", () => {
		expect(extractIndexTerm("   ")).toBe("(unspecified)");
	});

	it("trims surrounding whitespace from the term", () => {
		expect(extractIndexTerm("  Topic  ")).toBe("Topic");
	});
});

describe("bucketCommentsByHeading", () => {
	const heading = (heading: string, level: number, offset: number) => ({
		heading,
		level,
		position: { start: { offset } },
	});
	const comment = (start: number, resolved = false): Comment => ({
		id: undefined,
		category: "clarify",
		body: "x",
		date: undefined,
		author: undefined,
		anchor: undefined,
		marker: { start, end: start + 10 },
		replies: [],
		resolution: resolved
			? { date: "2026-01-01", author: "x", note: "" }
			: undefined,
	});

	it("returns an empty array when there are no headings", () => {
		expect(bucketCommentsByHeading([], [comment(50)])).toEqual([]);
	});

	it("returns zero-filled buckets when there are no comments", () => {
		expect(bucketCommentsByHeading([heading("H1", 1, 0)], [])).toEqual([
			{ open: 0, resolved: 0 },
		]);
	});

	it("does not count comments that sit before the first heading", () => {
		const result = bucketCommentsByHeading(
			[heading("H1", 1, 100)],
			[comment(50)],
		);
		expect(result).toEqual([{ open: 0, resolved: 0 }]);
	});

	it("buckets open and resolved comments into the most-recent heading", () => {
		const headings = [heading("H1", 1, 0), heading("H2", 1, 200)];
		const comments = [
			comment(50),
			comment(75, true),
			comment(250),
			comment(300),
		];
		expect(bucketCommentsByHeading(headings, comments)).toEqual([
			{ open: 1, resolved: 1 },
			{ open: 2, resolved: 0 },
		]);
	});
});

describe("computeScopeFileSet", () => {
	const mk = (
		path: string,
		extras: Partial<Omit<ScopeFile, "path">> = {},
	): ScopeFile => ({
		path,
		parentPath: extras.parentPath,
		isInRoot: extras.isInRoot ?? false,
		frontmatter: extras.frontmatter,
		tags: extras.tags ?? [],
	});

	const files: ScopeFile[] = [
		mk("root.md", { parentPath: "", isInRoot: true, tags: ["#draft"] }),
		mk("docs/intro.md", { parentPath: "docs", frontmatter: { status: "wip" } }),
		mk("docs/api.md", { parentPath: "docs", frontmatter: { status: "done", topics: ["auth", "api"] } }),
		mk("docs/nested/deep.md", { parentPath: "docs/nested", tags: ["#draft", "#review"] }),
	];

	const shape = (s: ScopeShape) => s;

	it("file scope returns just the anchor path", () => {
		expect(computeScopeFileSet(files, shape({ kind: "file" }), "docs/intro.md"))
			.toEqual(new Set(["docs/intro.md"]));
	});

	it("file scope with undefined anchor returns empty set", () => {
		expect(computeScopeFileSet(files, shape({ kind: "file" }), undefined))
			.toEqual(new Set<string>());
	});

	it("vault scope returns every path", () => {
		expect(computeScopeFileSet(files, shape({ kind: "vault" }), undefined))
			.toEqual(new Set(["root.md", "docs/intro.md", "docs/api.md", "docs/nested/deep.md"]));
	});

	it("folder scope without subfolders returns only direct children", () => {
		expect(computeScopeFileSet(files, shape({ kind: "folder", subfolders: false }), "docs"))
			.toEqual(new Set(["docs/intro.md", "docs/api.md"]));
	});

	it("folder scope with subfolders returns descendants too", () => {
		expect(computeScopeFileSet(files, shape({ kind: "folder", subfolders: true }), "docs"))
			.toEqual(new Set(["docs/intro.md", "docs/api.md", "docs/nested/deep.md"]));
	});

	it("folder scope with empty anchor + no subfolders returns root files only", () => {
		expect(computeScopeFileSet(files, shape({ kind: "folder", subfolders: false }), ""))
			.toEqual(new Set(["root.md"]));
	});

	it("folder scope with empty anchor + subfolders returns all files", () => {
		expect(computeScopeFileSet(files, shape({ kind: "folder", subfolders: true }), ""))
			.toEqual(new Set(["root.md", "docs/intro.md", "docs/api.md", "docs/nested/deep.md"]));
	});

	it("property scope matches scalar frontmatter values", () => {
		expect(computeScopeFileSet(files, shape({ kind: "property", key: "status", value: "wip" }), undefined))
			.toEqual(new Set(["docs/intro.md"]));
	});

	it("property scope matches values inside an array-valued frontmatter key", () => {
		expect(computeScopeFileSet(files, shape({ kind: "property", key: "topics", value: "auth" }), undefined))
			.toEqual(new Set(["docs/api.md"]));
	});

	it("tag scope matches files carrying the tag (with leading #)", () => {
		expect(computeScopeFileSet(files, shape({ kind: "tag", tag: "#draft" }), undefined))
			.toEqual(new Set(["root.md", "docs/nested/deep.md"]));
	});

	it("tag scope prepends # when the input lacks one", () => {
		expect(computeScopeFileSet(files, shape({ kind: "tag", tag: "draft" }), undefined))
			.toEqual(new Set(["root.md", "docs/nested/deep.md"]));
	});
});
