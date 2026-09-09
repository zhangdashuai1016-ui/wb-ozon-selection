import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRuntimePackage } from "./runtime-package.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || !path.isAbsolute(args[1])) {
  throw new Error("Usage: prepare-local-runtime.mjs --output /absolute/new/directory");
}
const receipt = await prepareRuntimePackage({
  sourceDirectory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  outputDirectory: args[1], nodeExecutable: process.execPath
});
console.log(JSON.stringify({ ...receipt, outputDirectory: args[1] }, null, 2));
