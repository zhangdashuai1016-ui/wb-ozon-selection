import fs from "node:fs/promises";
import path from "node:path";
import { persistJsonThroughRealTarget } from "./atomic-json-persistence.mjs";

export const CENTRAL_PERSISTENCE_ERROR = "Production state has no central persistence boundary.";

function clone(value) {
  return structuredClone(value);
}

function validDocument(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTransactionResult(outcome) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) || typeof outcome.changed !== "boolean") {
    throw new Error("BUSINESS_STATE_REPOSITORY_TRANSACTION_RESULT_INVALID");
  }
  if (outcome.changed && !validDocument(outcome.document)) {
    throw new Error("BUSINESS_STATE_REPOSITORY_TRANSACTION_DOCUMENT_REQUIRED");
  }
  return outcome;
}

export function initialBusinessStateDocument({ now = new Date().toISOString(), title = "WB 与 Ozon 选品评审台" } = {}) {
  return {
    meta: {
      version: 2,
      title,
      date: now.slice(0, 10),
      updatedAt: now,
      automationStarted: false
    },
    rules: {},
    candidates: [],
    dispatches: [],
    collaboration: {
      messages: [],
      delivery: []
    },
    runtime: {
      operationAudit: [],
      idempotencyRecords: []
    }
  };
}

function createRepository({ adapter, concurrencyScope, read, replace }) {
  let queue = Promise.resolve();
  const repository = {
    boundaryType: "business_state_repository",
    authoritative: true,
    adapter,
    concurrencyScope,
    multiUserReady: concurrencyScope === "database_transaction",
    async readSnapshot() {
      const document = await read();
      if (!validDocument(document)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
      return clone(document);
    },
    transact(mutator) {
      if (typeof mutator !== "function") throw new Error("BUSINESS_STATE_REPOSITORY_MUTATOR_REQUIRED");
      const operation = queue.then(async () => {
        const current = await repository.readSnapshot();
        const outcome = validateTransactionResult(await mutator(current));
        if (outcome.changed) await replace(clone(outcome.document));
        return outcome.result;
      });
      // `operation`仍原样返回给调用者并保留失败；这里只重置串行队列尾部，
      // 让一次失败不会永久阻断后续独立事务。
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    }
  };
  return Object.freeze(repository);
}

export function createJsonBusinessStateRepository({
  filePath,
  fileSystem = fs,
  atomicWriter = persistJsonThroughRealTarget,
  initializeIfMissing = false,
  initialDocument = () => initialBusinessStateDocument()
} = {}) {
  if (!filePath || typeof filePath !== "string") throw new Error("BUSINESS_STATE_REPOSITORY_FILE_REQUIRED");
  let lastReadUsedInitialDocument = false;
  return createRepository({
    adapter: "json",
    concurrencyScope: "single_process",
    read: async () => {
      try {
        const document = JSON.parse(await fileSystem.readFile(filePath, "utf8"));
        lastReadUsedInitialDocument = false;
        return document;
      } catch (error) {
        if (error?.code === "ENOENT" && initializeIfMissing) {
          const document = typeof initialDocument === "function" ? initialDocument() : initialDocument;
          if (!validDocument(document)) throw new Error("BUSINESS_STATE_REPOSITORY_INITIAL_DOCUMENT_INVALID");
          lastReadUsedInitialDocument = true;
          return clone(document);
        }
        throw error;
      }
    },
    replace: async (document) => {
      if (initializeIfMissing && lastReadUsedInitialDocument) {
        await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
      }
      await atomicWriter(filePath, document);
      lastReadUsedInitialDocument = false;
    }
  });
}

export function createMemoryBusinessStateRepository(initialDocument) {
  if (!validDocument(initialDocument)) throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID");
  let document = clone(initialDocument);
  return createRepository({
    adapter: "memory",
    concurrencyScope: "single_process",
    read: async () => clone(document),
    replace: async (next) => { document = clone(next); }
  });
}

export function createConfiguredBusinessStateRepository(configuration) {
  if (!configuration || configuration.schemaVersion !== "selection-review-runtime-configuration-v1") {
    throw new Error("BUSINESS_STATE_REPOSITORY_CONFIGURATION_INVALID");
  }
  if (configuration.stateAdapter === "json") {
    return createJsonBusinessStateRepository({
      filePath: configuration.dataFile,
      initializeIfMissing: configuration.initializeDataFile === true,
      initialDocument: () => initialBusinessStateDocument()
    });
  }
  throw new Error(`BUSINESS_STATE_REPOSITORY_ADAPTER_NOT_IMPLEMENTED:${configuration.stateAdapter}`);
}

export function assertBusinessStateRepositoryBoundary(repository) {
  if (!repository || repository.boundaryType !== "business_state_repository" ||
      repository.authoritative !== true || typeof repository.readSnapshot !== "function" ||
      typeof repository.transact !== "function") {
    const error = new Error(CENTRAL_PERSISTENCE_ERROR);
    error.code = "CENTRAL_PERSISTENCE_BOUNDARY_REQUIRED";
    throw error;
  }
  return Object.freeze({
    status: "business_state_repository_boundary_present",
    adapter: repository.adapter,
    concurrencyScope: repository.concurrencyScope,
    multiUserReady: repository.multiUserReady
  });
}

export function assertCentralPersistenceBoundary(repository) {
  const boundary = assertBusinessStateRepositoryBoundary(repository);
  if (boundary.multiUserReady !== true || boundary.concurrencyScope !== "database_transaction") {
    const error = new Error(CENTRAL_PERSISTENCE_ERROR);
    error.code = "CENTRAL_PERSISTENCE_BOUNDARY_REQUIRED";
    throw error;
  }
  return Object.freeze({ ...boundary, status: "central_persistence_boundary_present" });
}
