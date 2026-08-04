// LITRA のサードパーティライセンス一覧を生成する。
// アプリが実際に同梱する依存のみを対象とする:
//   - src-tauri (ネイティブ側、x86_64-pc-windows-msvc)
//   - frontend-rs (wasm フロント、wasm32-unknown-unknown)
// npm 依存は存在しない(TS フロントは Rust へ置換済み)ため対象外。
// 出力: public/third-party-licenses.json (wasm へ include_str)、
//       legal/THIRD_PARTY_LICENSES.json / .md (Tauri リソースとして同梱)。
// バージョンは src-tauri/tauri.conf.json を単一の真実とする。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tauriConf = JSON.parse(
  readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"),
);

function normalizeLicense(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => entry.type ?? entry).filter(Boolean).join(" OR ");
  }
  return "UNKNOWN";
}

function collectCargoLicenses(crateDir, platform) {
  const output = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--filter-platform", platform],
    { cwd: join(rootDir, crateDir), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const metadata = JSON.parse(output);
  return metadata.packages
    .filter((pkg) => typeof pkg.source === "string") // workspace メンバー自身を除外
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
    "This file lists third-party dependencies used by LITRA. It is generated from Cargo metadata (src-tauri and frontend-rs).",
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

const entries = dedupe([
  ...collectCargoLicenses("src-tauri", "x86_64-pc-windows-msvc"),
  ...collectCargoLicenses("frontend-rs", "wasm32-unknown-unknown"),
]);
const payload = {
  appName: tauriConf.productName,
  appVersion: tauriConf.version,
  sourceFiles: ["src-tauri/Cargo.lock", "frontend-rs/Cargo.lock"],
  entries,
};

mkdirSync(join(rootDir, "public"), { recursive: true });
mkdirSync(join(rootDir, "legal"), { recursive: true });
writeFileSync(join(rootDir, "public", "third-party-licenses.json"), `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(join(rootDir, "legal", "THIRD_PARTY_LICENSES.json"), `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(join(rootDir, "legal", "THIRD_PARTY_LICENSES.md"), markdownTable(entries));

console.log(`Generated ${entries.length} third-party license entries.`);
