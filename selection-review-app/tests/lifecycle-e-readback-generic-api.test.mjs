import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 33000 + (process.pid % 20000);
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

test("E回读入口对任意已验证生命周期SKU保持幂等，不再绑定火车候选ID", async (t) => {
  const source = JSON.parse(await readFile(path.join(appDir, "data", "candidates.json"), "utf8"));
  const reference = source.candidates.find((item) => item.lifecycleV11?.skuPackage?.eVerificationRecord);
  assert.ok(reference, "测试基线需要一条已经完成E验证的生命周期SKU");

  const candidate = structuredClone(reference);
  candidate.id = "GENERIC-LIFECYCLE-E-READBACK";
  const data = {
    ...source,
    candidates: [candidate],
    dispatches: []
  };
  const directory = await mkdtemp(path.join(tmpdir(), "lifecycle-e-generic-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify(data));

  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => child.kill("SIGTERM"));
  await waitForHealth(child, stderr);

  const verification = candidate.lifecycleV11.skuPackage.eVerificationRecord;
  const response = await fetch(`${baseUrl}/api/candidates/${candidate.id}/lifecycle/e-readback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dataRevision: candidate.dataRevision,
      path: verification.verificationPath,
      verifiedObservation: { platformProductId: verification.platformProductId }
    })
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.candidate.id, candidate.id);
  assert.equal(body.candidate.lifecycleV11.skuPackage.eVerificationRecord.verificationId, verification.verificationId);

  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(persisted.candidates[0].id, candidate.id);
  assert.equal(persisted.candidates[0].lifecycleV11.skuPackage.eVerificationRecord.verificationId, verification.verificationId);
  assert.equal(persisted.candidates[0].lifecycleV11.platformWrites, 0);
});
