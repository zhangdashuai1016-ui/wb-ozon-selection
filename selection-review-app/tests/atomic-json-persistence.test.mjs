import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistJsonThroughRealTarget } from "../lib/atomic-json-persistence.mjs";

test("atomic persistence updates the real data while preserving the shared symlink", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "selection-review-persist-"));
  const realFile = path.join(directory, "runtime.json");
  const sharedLink = path.join(directory, "candidates.json");
  await fs.writeFile(realFile, '{"revision":1}\n', "utf8");
  await fs.symlink(realFile, sharedLink);

  await persistJsonThroughRealTarget(sharedLink, { revision: 2 });

  assert.equal((await fs.lstat(sharedLink)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(realFile, "utf8")), { revision: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(sharedLink, "utf8")), { revision: 2 });
});
