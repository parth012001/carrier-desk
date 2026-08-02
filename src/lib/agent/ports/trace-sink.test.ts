import { afterEach, describe, expect, it, vi } from "vitest";

import { writeTrace } from "../trace";
import { type AgentDb, DrizzleTraceSink } from "./drizzle";

/**
 * The first test on any `Drizzle*` port, and it earns the exception: the trace
 * is rendered now, so where the numbering starts stopped being an
 * implementation detail and became what a reader sees.
 *
 * Note what this class is defending against, because it is not what the code
 * shipped on Day 4 could do. Nothing today builds two sinks for one run —
 * `startCall` builds one per call, the turn route reuses it, and a missing
 * session 409s rather than rebuilding. What makes the numbering worth resolving
 * from the table is Day 7's durable `SessionStore`, where a call outlives the
 * process that started it, plus the crash-and-restart that reaches the same
 * place today. These tests are written against that second writer.
 *
 * The fake answers `max(seq)` from what it has been given and ignores the
 * `where` clause — filtering by run is Drizzle's job, not this class's. That
 * the filter names the right run is checked live against Postgres instead
 * (two turns of one call, `seq` continuing rather than restarting), because a
 * fake that interpreted its own query would only be testing itself.
 */
type StoredRow = { runId: string; seq: number; type: string };

class FakeDb {
  readonly rows: StoredRow[] = [];
  readonly whereCalls: unknown[] = [];
  failNextRead = false;

  select() {
    return {
      from: () => ({
        where: async (condition: unknown) => {
          this.whereCalls.push(condition);
          if (this.failNextRead) {
            this.failNextRead = false;
            throw new Error("Neon connect timeout");
          }
          if (this.rows.length === 0) return [{ highest: null }];
          return [{ highest: Math.max(...this.rows.map((r) => r.seq)) }];
        },
      }),
    };
  }

  insert() {
    return {
      values: async (row: StoredRow) => {
        this.rows.push(row);
      },
    };
  }
}

const sinkFor = (db: FakeDb, runId: string) =>
  new DrizzleTraceSink(db as unknown as AgentDb, runId);

describe("DrizzleTraceSink — sequence numbering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a fresh run at zero", async () => {
    const db = new FakeDb();
    const sink = sinkFor(db, "run-1");

    await sink.write({ type: "user_message", result: "MC 186800" });
    await sink.write({ type: "tool_call", name: "lookup_carrier" });

    expect(db.rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(db.whereCalls).toHaveLength(1);
  });

  it("continues from what is already stored when a second sink takes over", async () => {
    // The bug this fix exists for. Turn 1 runs in one request and its sink is
    // discarded; turn 2 builds a new one for the same run. A per-instance
    // counter restarted at 0, and a pane ordering by seq interleaved turn 2's
    // rows into turn 1's.
    const db = new FakeDb();

    const turnOne = sinkFor(db, "run-1");
    await turnOne.write({ type: "user_message", result: "MC 186800" });
    await turnOne.write({ type: "tool_call", name: "lookup_carrier" });
    await turnOne.write({ type: "assistant_message", result: "You're verified." });

    const turnTwo = sinkFor(db, "run-1");
    await turnTwo.write({ type: "user_message", result: "What's the rate?" });
    await turnTwo.write({ type: "tool_call", name: "counter_offer" });

    expect(db.rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("hands overlapping writes distinct numbers", async () => {
    // The model issues tool calls in parallel within a step — lookup_carrier
    // and get_load arrived as one step on Day 3 — so two writes genuinely do
    // overlap. A read-then-increment would hand both the same seq, which the
    // unique index would then reject, dropping a row.
    const db = new FakeDb();
    const sink = sinkFor(db, "run-1");

    await Promise.all([
      sink.write({ type: "tool_call", name: "lookup_carrier" }),
      sink.write({ type: "tool_call", name: "get_load" }),
      sink.write({ type: "tool_call", name: "check_compliance" }),
    ]);

    expect([...db.rows.map((r) => r.seq)].sort()).toEqual([0, 1, 2]);
    // One read for the run, not one per write.
    expect(db.whereCalls).toHaveLength(1);
  });

  it("does not renumber from zero when the read fails, and recovers after", async () => {
    // Guessing 0 here would recreate the exact duplicate the fix prevents.
    // The row is dropped and logged instead, and the next one retries.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new FakeDb();

    const turnOne = sinkFor(db, "run-1");
    await turnOne.write({ type: "tool_call", name: "lookup_carrier" });
    await turnOne.write({ type: "tool_call", name: "get_load" });

    const turnTwo = sinkFor(db, "run-1");
    db.failNextRead = true;
    await writeTrace(turnTwo, { type: "tool_call", name: "counter_offer" });
    expect(db.rows.map((r) => r.seq)).toEqual([0, 1]);

    await turnTwo.write({ type: "tool_call", name: "book_load" });
    expect(db.rows.map((r) => r.seq)).toEqual([0, 1, 2]);
  });
});
