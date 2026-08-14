import fs from "node:fs/promises";

/**
 * 原子保存JSON，并保留开发入口到运行数据的符号链接本身。
 */
export async function persistJsonThroughRealTarget(filePath, data) {
  const targetFile = await fs.realpath(filePath).catch(() => filePath);
  const tempFile = `${targetFile}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, targetFile);
  return targetFile;
}
