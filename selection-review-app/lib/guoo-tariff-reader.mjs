import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_GUOO_TARIFF_PATH = path.join(
  PROJECT_ROOT,
  "data",
  "logistics",
  "GUOO产品资费测算表【2026.8.19更新】.xlsx",
);
const SHEET_NAME = "GUOO realFBS资费试算表";

function decodeXml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalized(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}

function routeIdentity(value) {
  return normalized(value).replace(/\b(?:pudo|courier)\b/g, "").replace(/\s+/g, " ").trim();
}

function columnNumber(reference) {
  const letters = String(reference).match(/^[A-Z]+/)?.[0] || "";
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
}

function sharedStrings(xml) {
  return [...String(xml || "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map((match) => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((part) => decodeXml(part[1]))
      .join(""));
}

function cellValue(cellXml, type, strings) {
  if (type === "inlineStr") {
    return [...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("");
  }
  const raw = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (raw === undefined) return null;
  if (type === "s") return strings[Number(raw)] ?? null;
  if (type === "str") return decodeXml(raw);
  const number = Number(raw);
  return Number.isFinite(number) ? number : decodeXml(raw);
}

export function parseWorksheetRows(xml, strings = []) {
  const rows = [];
  for (const rowMatch of String(xml || "").matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(rowMatch[1]);
    const cells = {};
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1];
      const reference = attributes.match(/\br="([A-Z]+\d+)"/)?.[1];
      if (!reference) continue;
      const type = attributes.match(/\bt="([^"]+)"/)?.[1] || "";
      cells[columnNumber(reference)] = cellValue(cellMatch[2] || "", type, strings);
    }
    rows[rowNumber] = cells;
  }
  return rows;
}

export function guooTariffRuleVersionFromPath(filePath = DEFAULT_GUOO_TARIFF_PATH) {
  const match = path.basename(filePath).match(/(20\d{2})[.\-](\d{1,2})[.\-](\d{1,2})/);
  if (!match) throw new Error("GUOO_TARIFF_VERSION_MISSING: 文件名没有可验证的资费日期");
  return `guoo-${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function numeric(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`GUOO_TARIFF_FIELD_INVALID: ${label}不是有效数字`);
  return number;
}

function lowerWeightLimit(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*-/);
  if (!match) throw new Error("GUOO_TARIFF_WEIGHT_LIMIT_MISSING: 当前线路没有明确重量下限");
  return Number(match[1]);
}

async function unzipEntry(filePath, entry, execFileImpl = execFile) {
  const { stdout } = await execFileImpl("/usr/bin/unzip", ["-p", filePath, entry], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function worksheetXml(filePath, execFileImpl) {
  const [workbook, relations, stringsXml] = await Promise.all([
    unzipEntry(filePath, "xl/workbook.xml", execFileImpl),
    unzipEntry(filePath, "xl/_rels/workbook.xml.rels", execFileImpl),
    unzipEntry(filePath, "xl/sharedStrings.xml", execFileImpl).catch(() => ""),
  ]);
  const escapedName = SHEET_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sheet = workbook.match(new RegExp(`<sheet\\b[^>]*name="${escapedName}"[^>]*r:id="([^"]+)"`, "u"));
  if (!sheet) throw new Error("GUOO_TARIFF_SHEET_MISSING: 找不到GUOO realFBS资费试算表");
  const relation = [...relations.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)]
    .map((match) => match[1])
    .find((attributes) => attributes.match(/\bId="([^"]+)"/)?.[1] === sheet[1]);
  const target = relation?.match(/\bTarget="([^"]+)"/)?.[1];
  if (!target) throw new Error("GUOO_TARIFF_SHEET_RELATION_MISSING");
  const entry = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  return {
    xml: await unzipEntry(filePath, entry, execFileImpl),
    strings: sharedStrings(stringsXml),
  };
}

export function selectGuooTariffRow(rows, requestedRoute) {
  const requested = routeIdentity(requestedRoute);
  if (!requested) throw new Error("GUOO_TARIFF_ROUTE_MISSING");
  let productType = "";
  let weightLimit = "";
  let declaredValueLimit = "";
  let sizeLimit = "";
  const candidates = [];
  for (let rowNumber = 10; rowNumber <= 24; rowNumber += 1) {
    const row = rows[rowNumber] || {};
    if (String(row[2] || "").trim()) productType = String(row[2]).trim();
    if (String(row[7] || "").trim()) weightLimit = String(row[7]).trim();
    if (String(row[8] || "").trim()) declaredValueLimit = String(row[8]).trim();
    if (String(row[9] || "").trim()) sizeLimit = String(row[9]).trim();
    const routeCell = String(row[3] || "").trim();
    if (!routeCell) continue;
    const firstEnglishLine = routeCell.split(/\r?\n/).find((line) => /^GUOO\s+/i.test(line.trim())) || "";
    if (routeIdentity(firstEnglishLine) !== requested) continue;
    candidates.push({ rowNumber, row, productType, weightLimit, declaredValueLimit, sizeLimit, routeCell });
  }
  if (candidates.length !== 1) {
    throw new Error(candidates.length
      ? "GUOO_TARIFF_ROUTE_AMBIGUOUS: 当前线路匹配到多条资费"
      : "GUOO_TARIFF_ROUTE_NOT_FOUND: 当前表格没有该精确线路");
  }
  return candidates[0];
}

export async function readCurrentGuooTariff({
  scope,
  filePath = DEFAULT_GUOO_TARIFF_PATH,
  execFileImpl,
  readFileImpl = readFile,
  now = () => new Date(),
} = {}) {
  const currentRuleVersion = guooTariffRuleVersionFromPath(filePath);
  if (normalized(scope?.ruleVersion) !== normalized(currentRuleVersion)) {
    throw new Error(`GUOO_TARIFF_VERSION_MISMATCH: 当前文件是${currentRuleVersion}`);
  }
  const [{ xml, strings }, bytes] = await Promise.all([
    worksheetXml(filePath, execFileImpl),
    readFileImpl(filePath),
  ]);
  const selected = selectGuooTariffRow(parseWorksheetRows(xml, strings), scope?.route);
  const perKgRmb = numeric(selected.row[11], "每公斤资费");
  const perParcelRmb = numeric(selected.row[12], "每票资费");
  const checkedAt = now().toISOString();
  const bigRoute = /\bbig\b/i.test(selected.productType);
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  return {
    current: true,
    scope: { route: String(scope.route).trim(), ruleVersion: String(scope.ruleVersion).trim() },
    sourceType: "guoo_current_tariff_xlsx",
    sourceRef: `guoo-xlsx:${path.basename(filePath)}:sha256:${fileHash}:row-${selected.rowNumber}`,
    checkedAt,
    expiresAt: new Date(Date.parse(checkedAt) + 7 * 24 * 60 * 60 * 1000).toISOString(),
    evidenceData: {
      chargeableWeightRule: bigRoute ? "max_actual_volume" : "actual_weight",
      perKgRmb,
      perParcelRmb,
      minimumChargeableWeightKg: lowerWeightLimit(selected.weightLimit),
      weightRoundingRule: "none",
      weightRoundingKg: null,
      ...(bigRoute ? { volumeDivisorCm3PerKg: 12000 } : {}),
      productType: selected.productType,
      weightLimit: selected.weightLimit,
      declaredValueLimitRub: selected.declaredValueLimit,
      sizeLimit: selected.sizeLimit,
      batteryTransportRule: String(selected.row[10] || "").trim(),
      transportMethod: String(selected.row[4] || "").trim(),
      tariffFormula: String(selected.row[6] || "").trim(),
    },
  };
}
