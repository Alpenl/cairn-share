import { expect } from "vitest";

// Event assertions stay exact after checking the common transport fields, so
// an accidental private field still fails the business-event shape test.
export function withoutLogEnvelope(entry: Record<string, unknown>): Record<string, unknown> {
  expect(entry.service).toBe("cairn-share-worker");
  expect(entry.time_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const { time_utc: _time, service: _service, ...event } = entry;
  return event;
}
