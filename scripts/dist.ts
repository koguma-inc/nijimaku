// Windows（x64）用の配布物をdist/に作る。全部入りZIP・アプリ部分だけのZIP・SHA256SUMS.txt。
// 入れるファイルは列挙したものだけ（許可リスト）にし、作ったZIPの中身を検査する。
// ZIPはMacとWindowsに標準で入っているbsdtarで作る。
//
// 実行: nr dist
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bsdtarPath } from "../src/bsdtar.ts";
import { fetchNode } from "./fetch-node.ts";

// サーバーがpublic/から配信する拡張子
const PUBLIC_EXTS = new Set([".html", ".js", ".css"]);
const RUNTIME_DEPS = ["openai", "ws"];
// app/直下に置き、版のフォルダには入れないもの
const LAUNCHER_FILES = ["launcher.ts", "launch-state.ts"];

// 利用者のAPIキー・設定・ログと、開発用のファイル。許可リストから漏れても、ここで見つける。
// ZIPのルート・app/・app/versions/<版>/のそれぞれを起点に当てる
const FORBIDDEN_AT_ROOT = [/^credentials\.json/, /^\.env/, /^settings.*\.json/, /^(AGENTS|CLAUDE|README)\.md$/, /^(logs|note|samples|scripts|\.plan|\.git)\//];
const FORBIDDEN_ANYWHERE = [/(^|\/)\.DS_Store$/, /(^|\/)\._/, /\.test\.ts$/];
// エクスプローラーの「すべて展開」は260文字を超えるパスで失敗する。
// 展開先（C:\Users\<名前>\Downloads\nijimaku-<版>-win-x64\）に約100文字を見込む
const MAX_ENTRY_PATH = 150;
const VERSION_DIR = /^app\/versions\/([^/]+)\//;

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const root = path.join(import.meta.dirname, "..");
  const distDir = path.join(root, "dist");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name: string; version: string };
  const name = `${pkg.name}-${pkg.version}-win-x64`;
  const stage = path.join(distDir, name);
  const appStage = path.join(stage, "app", "versions", pkg.version);
  const fullZip = path.join(distDir, `${name}.zip`);
  const appZip = path.join(distDir, `${pkg.name}-${pkg.version}-app.zip`);
  const sums = path.join(distDir, "SHA256SUMS.txt");

  const nodeDir = await fetchNode();
  for (const target of [stage, fullZip, appZip, sums]) rmSync(target, { recursive: true, force: true });

  const copy = (from: string, to: string): void => {
    mkdirSync(path.dirname(path.join(stage, to)), { recursive: true });
    copyFileSync(from, path.join(stage, to));
  };
  const write = (to: string, data: string): void => {
    mkdirSync(path.dirname(path.join(stage, to)), { recursive: true });
    writeFileSync(path.join(stage, to), data);
  };
  const json = (data: unknown): string => JSON.stringify(data, null, 2) + "\n";
  const versionDir = `app/versions/${pkg.version}`;

  // cmd.exeはLFだけの改行を誤って解釈することがある
  write("start.cmd", readFileSync(path.join(root, "start.cmd"), "utf8").replace(/\r?\n/g, "\r\n"));
  copy(path.join(root, "LICENSE"), "LICENSE");
  copy(path.join(nodeDir, "node.exe"), "node/node.exe");
  copy(path.join(nodeDir, "LICENSE"), "node/LICENSE");

  // .tsをESMとして読ませるのに"type"が要る
  write("app/package.json", json({ private: true, type: "module" }));
  for (const file of LAUNCHER_FILES) copy(path.join(root, "src", file), `app/${file}`);
  write("app/current.json", json({ app: pkg.version }));

  const srcFiles = listFiles(root, "src", (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !LAUNCHER_FILES.includes(file));
  const publicFiles = listFiles(root, "public", (file) => PUBLIC_EXTS.has(path.extname(file)));
  for (const file of [...srcFiles, ...publicFiles]) copy(path.join(root, file), `${versionDir}/${file}`);
  // pnpmのnode_modulesはシンボリックリンクなので、実体をコピーする。どちらも実行時の依存を持たない
  for (const dep of RUNTIME_DEPS) {
    cpSync(realpathSync(path.join(root, "node_modules", dep)), path.join(appStage, "node_modules", dep), { recursive: true });
  }
  write(`${versionDir}/package.json`, json({ name: pkg.name, version: pkg.version, private: true, type: "module", nijimaku: { launcher: 1 } }));
  copy(path.join(root, "runtime.json"), `${versionDir}/runtime.json`);

  makeZip(stage, fullZip);
  makeZip(appStage, appZip);
  inspectFullZip(fullZip, stage);
  inspectAppZip(appZip, appStage);

  const lines = [fullZip, appZip].map((zip) => `${createHash("sha256").update(readFileSync(zip)).digest("hex")}  ${path.basename(zip)}\n`);
  writeFileSync(sums, lines.join(""));
  for (const zip of [fullZip, appZip]) console.log(`${zip} (${(statSync(zip).size / 1024 / 1024).toFixed(1)}MB)`);
  console.log(sums);
}

function listFiles(root: string, dir: string, include: (name: string) => boolean): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && include(entry.name))
    .map((entry) => `${dir}/${entry.name}`);
}

// dirの中身をZIPのルートに置いたZIPを作る
export function makeZip(dir: string, zip: string): void {
  // MacのtarがAppleDouble（._で始まるファイル）を足さないようにする
  execFileSync(bsdtarPath(), ["-a", "-c", "-f", zip, "-C", dir, ...readdirSync(dir)], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
}

// 全部入りZIP（stageはステージングのルート）を検査する
export function inspectFullZip(zip: string, stage: string): void {
  const entries = inspectZip(zip, stage);

  const cmd = tar("-x", "-O", "-f", zip, "start.cmd");
  if (/(^|[^\r])\n/.test(cmd) || /[^\x00-\x7f]/.test(cmd)) throw new Error("start.cmdがCRLFのASCIIになっていません");

  const current = JSON.parse(tar("-x", "-O", "-f", zip, "app/current.json")) as { app?: unknown };
  const versions = [...new Set(entries.flatMap((entry) => VERSION_DIR.exec(entry)?.[1] ?? []))];
  if (versions.length !== 1 || versions[0] !== current.app) {
    throw new Error(`app/current.jsonの版（${String(current.app)}）とapp/versions/の版のフォルダ（${versions.join(", ")}）が一致しません`);
  }

  const longest = entries.reduce((a, b) => (b.length > a.length ? b : a), "");
  if (longest.length > MAX_ENTRY_PATH) throw new Error(`ZIP内のパスが${MAX_ENTRY_PATH}文字を超えています: ${longest} (${longest.length}文字)`);
}

// アプリZIP（stageはapp/versions/<版>/のステージング）を検査する
export function inspectAppZip(zip: string, stage: string): void {
  inspectZip(zip, stage);
}

// ZIPのファイルがステージングと一致し、禁止ファイルが無いことを確かめ、ファイルのエントリーを返す
function inspectZip(zip: string, stage: string): string[] {
  const entries = tar("-t", "-f", zip)
    .split(/\r?\n/)
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry && !entry.endsWith("/"));
  const staged = readdirSync(stage, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(stage, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
  const entrySet = new Set(entries);
  const stagedSet = new Set(staged);
  const extra = entries.filter((entry) => !stagedSet.has(entry));
  const missing = staged.filter((file) => !entrySet.has(file));
  if (extra.length || missing.length) throw new Error(`ZIPの中身が想定と違います（${path.basename(zip)}）。余分: ${extra.join(", ")} 不足: ${missing.join(", ")}`);

  const forbidden = entries.filter((entry) => {
    const roots = [entry, entry.replace(/^app\//, ""), entry.replace(VERSION_DIR, "")];
    return roots.some((rel) => FORBIDDEN_AT_ROOT.some((re) => re.test(rel))) || FORBIDDEN_ANYWHERE.some((re) => re.test(entry));
  });
  if (forbidden.length) throw new Error(`ZIPに入れてはいけないファイルがあります（${path.basename(zip)}）: ${forbidden.join(", ")}`);
  return entries;
}

function tar(...args: string[]): string {
  return execFileSync(bsdtarPath(), args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
