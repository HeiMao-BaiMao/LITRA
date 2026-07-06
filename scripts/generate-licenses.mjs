import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(join(rootDir, "package-lock.json"), "utf8"));

function normalizeLicense(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => entry.type ?? entry).filter(Boolean).join(" OR ");
  }
  return "UNKNOWN";
}

function normalizeRepository(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.url === "string") {
    return value.url.replace(/^git\+/, "");
  }
  return undefined;
}

function collectNodeLicenses() {
  const entries = [];
  for (const [path, meta] of Object.entries(packageLock.packages ?? {})) {
    if (!path.startsWith("node_modules/")) continue;
    if (meta.dev) continue;

    entries.push({
      ecosystem: "npm",
      name: meta.name ?? path.replace(/^node_modules\//, ""),
      version: meta.version ?? "",
      license: normalizeLicense(meta.license),
      source: normalizeRepository(meta.repository) ?? meta.resolved,
      homepage: meta.homepage,
    });
  }
  return entries;
}

function collectCargoLicenses() {
  const output = execFileSync("cargo", ["metadata", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc"], {
    cwd: join(rootDir, "src-tauri"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const metadata = JSON.parse(output);
  return metadata.packages
    .filter((pkg) => typeof pkg.source === "string")
    .map((pkg) => ({
      ecosystem: "cargo",
      name: pkg.name,
      version: pkg.version,
      license: normalizeLicense(pkg.license),
      source: pkg.repository ?? pkg.homepage ?? pkg.source,
      homepage: pkg.homepage,
    }));
}

function dedupe(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    byKey.set(`${entry.ecosystem}:${entry.name}@${entry.version}`, entry);
  }
  return [...byKey.values()].sort((left, right) =>
    `${left.ecosystem}:${left.name}@${left.version}`.localeCompare(
      `${right.ecosystem}:${right.name}@${right.version}`,
      "en",
    ),
  );
}

function markdownTable(entries) {
  const lines = [
    "# Third-Party Licenses",
    "",
    "This file lists third-party dependencies used by LITRA. It is generated from package-lock.json and Cargo metadata.",
    "",
    "| Ecosystem | Package | Version | License | Source |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const entry of entries) {
    const source = entry.source ? `[link](${entry.source})` : "";
    lines.push(`| ${entry.ecosystem} | ${entry.name} | ${entry.version} | ${entry.license} | ${source} |`);
  }
  lines.push("");
  return lines.join("\n");
}

const entries = dedupe([...collectNodeLicenses(), ...collectCargoLicenses()]);
const payload = {
  appName: "LITRA",
  appVersion: packageJson.version,
  sourceFiles: ["package-lock.json", "src-tauri/Cargo.lock"],
  entries,
};

mkdirSync(join(rootDir, "public"), { recursive: true });
mkdirSync(join(rootDir, "legal"), { recursive: true });
writeFileSync(join(rootDir, "public", "third-party-licenses.json"), `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(join(rootDir, "legal", "THIRD_PARTY_LICENSES.json"), `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(join(rootDir, "legal", "THIRD_PARTY_LICENSES.md"), markdownTable(entries));

console.log(`Generated ${entries.length} third-party license entries.`);
