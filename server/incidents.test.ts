import { describe, expect, it } from "vitest";
import { weekStarts } from "./incidents.ts";

describe("weekStarts", () => {
  it("names the Mondays of the last weeks in UTC, this week last", () => {
    // Saturday 24 October 2026; its week starts on Monday the 19th.
    expect(weekStarts(3, new Date("2026-10-24T23:30:00.000Z"))).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    // A Monday starts its own week, and a Sunday belongs to the week before.
    expect(weekStarts(1, new Date("2026-10-19T00:00:00.000Z"))).toEqual(["2026-10-19"]);
    expect(weekStarts(1, new Date("2026-10-18T12:00:00.000Z"))).toEqual(["2026-10-12"]);
  });
});
