import { CommentIndex } from "../index";

describe("CommentIndex", () => {
	const SAMPLE = `# A note

First paragraph. <!-- annoteca/tone: doesn't sound like me
[id=aaaa1111]
[date=2026-05-23]
-->

Second paragraph. <!-- annoteca/clarify: which products? -->

Third paragraph. <!-- annoteca/cut: too long
[id=bbbb2222]
[resolved charles 2026-05-25]: cut in revision
-->`;

	it("rebuilds the index for a file from its content", () => {
		const idx = new CommentIndex();
		idx.rebuild("note.md", SAMPLE);
		const file = idx.get("note.md");
		expect(file?.comments).toHaveLength(3);
	});

	it("queries unresolved comments by default", () => {
		const idx = new CommentIndex();
		idx.rebuild("note.md", SAMPLE);
		const unresolved = idx.queryUnresolved();
		expect(unresolved).toHaveLength(2);
		const categories = unresolved.map(c => c.comment.category).sort();
		expect(categories).toEqual(["clarify", "tone"]);
	});

	it("filters by category and resolved state", () => {
		const idx = new CommentIndex();
		idx.rebuild("note.md", SAMPLE);
		const cuts = idx.queryUnresolved({
			categories: new Set(["cut"]),
			resolved: "all",
		});
		expect(cuts).toHaveLength(1);
	});

	it("detects ID collisions across files", () => {
		const idx = new CommentIndex();
		idx.rebuild("a.md", `<!-- annoteca/tone: body
[id=aaaa1111]
-->`);
		idx.rebuild("b.md", `<!-- annoteca/cut: body
[id=bbbb2222]
-->`);
		expect(idx.hasId("aaaa1111")).toBe(true);
		expect(idx.hasId("bbbb2222")).toBe(true);
		expect(idx.hasId("zzzzzzzz")).toBe(false);
	});

	it("renames file entries", () => {
		const idx = new CommentIndex();
		idx.rebuild("old.md", SAMPLE);
		idx.rename("old.md", "new.md");
		expect(idx.get("old.md")).toBeUndefined();
		expect(idx.get("new.md")?.comments).toHaveLength(3);
	});

	it("drops file entries on remove", () => {
		const idx = new CommentIndex();
		idx.rebuild("note.md", SAMPLE);
		idx.remove("note.md");
		expect(idx.get("note.md")).toBeUndefined();
	});

	it("reports stats", () => {
		const idx = new CommentIndex();
		idx.rebuild("note.md", SAMPLE);
		const s = idx.stats();
		expect(s.fileCount).toBe(1);
		expect(s.commentCount).toBe(3);
		expect(s.unresolvedCount).toBe(2);
	});
});
