import { captureSnapshot, detectDrift } from "../drift";
import { parseAll } from "../parser";

describe("drift: captureSnapshot", () => {
	it("captures normalized surrounding text", () => {
		const text = `Some prose before. <!-- annoteca/tone: x --> More prose after.`;
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		const snap = captureSnapshot(text, c);
		expect(snap.before).toContain("prose before");
		expect(snap.after).toContain("More prose after");
	});
});

describe("drift: detectDrift", () => {
	it("returns no findings on first run", () => {
		const text = `prose <!-- annoteca/tone: x
[id=aaaa1111]
--> end.`;
		const comments = parseAll(text);
		const r = detectDrift(text, "note.md", comments, {});
		expect(r.findings).toHaveLength(0);
		expect(r.refreshedSnapshots["aaaa1111"]).toBeDefined();
	});

	it("flags drift when surrounding text changes", () => {
		const before = `original prose <!-- annoteca/tone: x
[id=aaaa1111]
--> end.`;
		const after = `completely different prose <!-- annoteca/tone: x
[id=aaaa1111]
--> end.`;
		const firstRun = detectDrift(before, "note.md", parseAll(before), {});
		const secondRun = detectDrift(after, "note.md", parseAll(after), firstRun.refreshedSnapshots);
		expect(secondRun.findings).toHaveLength(1);
	});

	it("does not flag when text is unchanged", () => {
		const text = `prose <!-- annoteca/tone: x
[id=aaaa1111]
--> end.`;
		const firstRun = detectDrift(text, "note.md", parseAll(text), {});
		const secondRun = detectDrift(text, "note.md", parseAll(text), firstRun.refreshedSnapshots);
		expect(secondRun.findings).toHaveLength(0);
	});
});
