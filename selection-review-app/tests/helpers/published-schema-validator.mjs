import { readFile, readdir } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export async function loadPublishedSchemaValidator() {
  const directory = new URL("../../schema/", import.meta.url);
  const files = (await readdir(directory)).filter(name => name.endsWith(".schema.json"));
  const schemas = await Promise.all(files.map(name => readFile(new URL(name, directory), "utf8").then(JSON.parse)));
  const validator = new Ajv2020({ strict: true, allErrors: true });
  addFormats(validator);
  files.forEach((name, index) => validator.addSchema(schemas[index], name));
  return validator;
}
