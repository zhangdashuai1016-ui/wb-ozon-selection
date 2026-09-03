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

test("atomic persistence preserves existing file permissions and never reuses a fixed temp path", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "selection-review-persist-mode-"));
  const filePath = path.join(directory, "runtime.json");
  await fs.writeFile(filePath, '{"revision":1}\n', { mode: 0o640 });
  await fs.chmod(filePath, 0o640);

  const results = await Promise.all([
    persistJsonThroughRealTarget(filePath, { writer: "left" }),
    persistJsonThroughRealTarget(filePath, { writer: "right" })
  ]);

  const realFilePath = await fs.realpath(filePath);
  assert.deepEqual(results, [realFilePath, realFilePath]);
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.ok(["left", "right"].includes(persisted.writer));
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o640);
  const leftovers = (await fs.readdir(directory)).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("atomic persistence does not create parent directories outside explicit repository init", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "selection-review-persist-no-mkdir-"));
  const missingParent = path.join(directory, "missing-parent");
  const filePath = path.join(missingParent, "runtime.json");

  await assert.rejects(
    persistJsonThroughRealTarget(filePath, { revision: 1 }),
    /ENOENT/
  );
  await assert.rejects(fs.stat(missingParent), /ENOENT/);
});

test("atomic persistence rejects dangling symlink targets instead of replacing the shared link", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "selection-review-persist-dangling-"));
  const missingTarget = path.join(directory, "missing-runtime.json");
  const sharedLink = path.join(directory, "candidates.json");
  await fs.symlink(missingTarget, sharedLink);

  await assert.rejects(
    persistJsonThroughRealTarget(sharedLink, { revision: 1 }),
    /ATOMIC_JSON_DANGLING_SYMLINK_TARGET/
  );
  assert.equal((await fs.lstat(sharedLink)).isSymbolicLink(), true);
  await assert.rejects(fs.stat(missingTarget), /ENOENT/);
});

test("atomic persistence reports directory close failures after replace as durability-unconfirmed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "selection-review-persist-dir-close-"));
  const realDirectory = await fs.realpath(directory);
  const filePath = path.join(directory, "runtime.json");
  await fs.writeFile(filePath, '{"revision":1}\n', "utf8");
  const fileSystem = {
    ...fs,
    async open(target, flags, mode) {
      const handle = await fs.open(target, flags, mode);
      if (target === realDirectory && flags === "r") {
        return {
          async sync() {
            await handle.sync();
          },
          async close() {
            await handle.close();
            throw new Error("simulated_directory_close_failure");
          }
        };
      }
      return handle;
    }
  };

  await assert.rejects(
    persistJsonThroughRealTarget(filePath, { revision: 2 }, { fileSystem }),
    (error) => error.code === "ATOMIC_JSON_DURABILITY_UNCONFIRMED" &&
      error.replaced === true &&
      /simulated_directory_close_failure/.test(String(error.cause))
  );
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { revision: 2 });
});
