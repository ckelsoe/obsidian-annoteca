import { formatStamp, truncate } from "../view-utils";

describe("view-utils: formatStamp", () => {
	it("renders a full timestamp as date and time, keeping seconds", () => {
		expect(formatStamp("2026-06-22T14:30:12")).toBe("2026-06-22 14:30:12");
	});

	it("renders a timestamp with no seconds as date plus HH:MM", () => {
		expect(formatStamp("2026-06-22T14:30")).toBe("2026-06-22 14:30");
	});

	it("passes a legacy date-only stamp through unchanged", () => {
		expect(formatStamp("2026-06-22")).toBe("2026-06-22");
	});
});

describe("view-utils: truncate", () => {
	it("returns text unchanged when within the limit", () => {
		expect(truncate("short", 10)).toBe("short");
	});

	it("returns text unchanged when exactly at the limit", () => {
		expect(truncate("exactly10!", 10)).toBe("exactly10!");
	});

	it("cuts to the limit and appends a single ellipsis when over", () => {
		expect(truncate("abcdefghij", 5)).toBe("abcde…");
	});
});
