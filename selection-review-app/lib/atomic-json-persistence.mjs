import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

async function targetMode(fileSystem, filePath) {
  try {
    const stat = await fileSystem.stat(filePath);
    return stat.mode & 0o777;
  } catch (error) {
    if (error?.code === "ENOENT") return 0o600;
    throw error;
  }
}

async function closeAfterFailure(fileHandle, originalError) {
  if (!fileHandle) return;
  try {
    await fileHandle.close();
  } catch (closeError) {
    originalError.closeError = closeError;
  }
}

function durabilityError(targetFile, cause) {
  const error = new Error("ATOMIC_JSON_DURABILITY_UNCONFIRMED");
  error.code = "ATOMIC_JSON_DURABILITY_UNCONFIRMED";
  error.targetFile = targetFile;
  error.replaced = true;
  error.cause = cause;
  return error;
}

async function fsyncContainingDirectory(fileSystem, directory, targetFile) {
  let directoryHandle;
  try {
    directoryHandle = await fileSystem.open(directory, "r");
    await directoryHandle.sync();
  } catch (error) {
    await closeAfterFailure(directoryHandle, error);
    throw durabilityError(targetFile, error);
  }
  try {
    await directoryHandle.close();
  } catch (error) {
    throw durabilityError(targetFile, error);
  }
}

async function resolveRealTarget(fileSystem, filePath) {
  try {
    return await fileSystem.realpath(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const linkStat = await fileSystem.lstat(filePath).catch((lstatError) => {
      if (lstatError?.code === "ENOENT") return null;
      throw lstatError;
    });
    if (linkStat?.isSymbolicLink?.()) {
      const danglingError = new Error("ATOMIC_JSON_DANGLING_SYMLINK_TARGET");
      danglingError.code = "ATOMIC_JSON_DANGLING_SYMLINK_TARGET";
      danglingError.targetFile = filePath;
      throw danglingError;
    }
    return filePath;
  }
}

/**
 * 原子保存JSON，并保留开发入口到运行数据的符号链接本身。
 */
export async function persistJsonThroughRealTarget(filePath, data, { fileSystem = fs } = {}) {
  const targetFile = await resolveRealTarget(fileSystem, filePath);
  const directory = path.dirname(targetFile);
  const mode = await targetMode(fileSystem, targetFile);
  const tempFile = path.join(directory, `${path.basename(targetFile)}.${process.pid}.${randomUUID()}.tmp`);
  let fileHandle;
  let replaced = false;
  try {
    fileHandle = await fileSystem.open(tempFile, "wx", mode);
    await fileHandle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    await fileSystem.chmod(tempFile, mode);
    await fileSystem.rename(tempFile, targetFile);
    replaced = true;
    await fsyncContainingDirectory(fileSystem, directory, targetFile);
    return targetFile;
  } catch (error) {
    await closeAfterFailure(fileHandle, error);
    if (!replaced) {
      try {
        await fileSystem.unlink(tempFile);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
}
