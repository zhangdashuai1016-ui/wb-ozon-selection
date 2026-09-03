import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("4317部署包包含已验收ali-oss运行依赖且绝不覆盖共享候选数据", async () => {
  const [script, packageJson] = await Promise.all([
    readFile(new URL("../scripts/deploy-local-runtime.sh", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse)
  ]);
  assert.equal(packageJson.dependencies["ali-oss"], "6.23.0");
  assert.match(script, /PROJECT_NODE_MODULES\/ali-oss\/package\.json/);
  assert.match(script, /rsync -a --delete "\$PROJECT_NODE_MODULES\/" "\$RUNTIME_ROOT\/node_modules\/"/);
  assert.doesNotMatch(script, /pnpm (?:install|add)|npm (?:install|i)|yarn (?:install|add)/);
  assert.doesNotMatch(script, /cp .*candidates\.json|rsync .*data\//);
});
