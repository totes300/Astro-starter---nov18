import assert from "node:assert/strict";
import { test } from "node:test";
import { partitionLocked, releaseLock } from "./releases";

const RELEASES = [
  { name: "open", state: "active" },
  { name: "launch", state: "scheduled", title: "Launch" },
  { name: "moving", state: "scheduling" },
];

test("only a version in a release that is not active is locked", () => {
  assert.equal(releaseLock("page", RELEASES), undefined);
  assert.equal(releaseLock("drafts.page", RELEASES), undefined);
  assert.equal(releaseLock("versions.open.page", RELEASES), undefined);
  assert.match(releaseLock("versions.launch.page", RELEASES) ?? "", /"Launch" \(launch\), which is scheduled\. Unschedule it/);
  assert.match(releaseLock("versions.moving.page", RELEASES) ?? "", /"moving", which is scheduling/);
  assert.match(releaseLock("versions.gone.page", RELEASES) ?? "", /"gone", which could not be read/);
});

test("planned writes split into those Sanity accepts and those it refuses", () => {
  const { open, locked } = partitionLocked(
    [{ id: "page" }, { id: "versions.launch.page" }, { id: "versions.open.page" }],
    RELEASES
  );

  assert.deepEqual(
    open.map(({ id }) => id),
    ["page", "versions.open.page"]
  );
  assert.deepEqual(
    locked.map(({ id }) => id),
    ["versions.launch.page"]
  );
});
