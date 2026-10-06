// Windows（x64）用の配布ZIPをdist/に作る。入れるファイルは列挙したものだけ（許可リスト）にし、
// 作ったZIPの中身を検査する。ZIPはMacとWindowsに標準で入っているtar（bsdtar）で作る。
//
// 実行: nr dist
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchNode } from "./fetch-node.ts";

const ROOT = path.join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { name: string; version: string };
const NAME = `${pkg.name}-${pkg.version}-win-x64`;
const STAGE = path.join(ROOT, "dist", NAME);
const ZIP = path.join(ROOT, "dist", `${NAME}.zip`);
// サーバーがpublic/から配信する拡張子
const PUBLIC_EXTS = new Set([".html", ".js", ".css"]);
const RUNTIME_DEPS = ["openai", "ws"];

// 利用者のAPIキー・設定・ログと、開発用のファイル。許可リストから漏れても、ここで見つける
const FORBIDDEN_AT_ROOT = [/^credentials\.json/, /^\.env/, /^settings.*\.json/, /^(AGENTS|CLAUDE)\.md$/, /^(logs|note|samples|scripts|\.plan|\.git)\//];
const FORBIDDEN_ANYWHERE = [/(^|\/)\.DS_Store$/, /(^|\/)\._/, /\.test\.ts$/];

try {
  const nodeDir = await fetchNode();
  rmSync(STAGE, { recursive: true, force: true });
  rmSync(ZIP, { force: true });

  const files = [
    "README.md",
    ...listFiles("src", (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
    ...listFiles("public", (name) => PUBLIC_EXTS.has(path.extname(name))),
  ];
  for (const file of files) copy(path.join(ROOT, file), file);
  copy(path.join(nodeDir, "node.exe"), "node/node.exe");
  copy(path.join(nodeDir, "LICENSE"), "node/LICENSE");
  // pnpmのnode_modulesはシンボリックリンクなので、実体をコピーする。どちらも実行時の依存を持たない
  for (const dep of RUNTIME_DEPS) {
    cpSync(realpathSync(path.join(ROOT, "node_modules", dep)), path.join(STAGE, "node_modules", dep), { recursive: true });
  }
  // cmd.exeはLFだけの改行を誤って解釈することがある
  write("start.cmd", readFileSync(path.join(ROOT, "start.cmd"), "utf8").replace(/\r?\n/g, "\r\n"));
  // .tsをESMとして読ませるのに"type"が要る
  write("package.json", JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module" }, null, 2) + "\n");

  // MacのtarがAppleDouble（._で始まるファイル）を足さないようにする
  execFileSync("tar", ["-a", "-c", "-f", ZIP, "-C", STAGE, ...readdirSync(STAGE)], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  inspect();
  console.log(`${ZIP} (${(statSync(ZIP).size / 1024 / 1024).toFixed(1)}MB)`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

function listFiles(dir: string, include: (name: string) => boolean): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && include(entry.name))
    .map((entry) => `${dir}/${entry.name}`);
}

function copy(from: string, to: string): void {
  mkdirSync(path.dirname(path.join(STAGE, to)), { recursive: true });
  copyFileSync(from, path.join(STAGE, to));
}

function write(to: string, data: string): void {
  writeFileSync(path.join(STAGE, to), data);
}

function inspect(): void {
  const entries = tar("-t", "-f", ZIP).split("\n").filter((entry) => entry && !entry.endsWith("/"));
  const staged = readdirSync(STAGE, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(STAGE, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
  const entrySet = new Set(entries);
  const stagedSet = new Set(staged);
  const extra = entries.filter((entry) => !stagedSet.has(entry));
  const missing = staged.filter((file) => !entrySet.has(file));
  if (extra.length || missing.length) throw new Error(`ZIPの中身が想定と違います。余分: ${extra.join(", ")} 不足: ${missing.join(", ")}`);

  const forbidden = entries.filter(
    (entry) => FORBIDDEN_AT_ROOT.some((re) => re.test(entry)) || FORBIDDEN_ANYWHERE.some((re) => re.test(entry)),
  );
  if (forbidden.length) throw new Error(`ZIPに入れてはいけないファイルがあります: ${forbidden.join(", ")}`);

  const cmd = tar("-x", "-O", "-f", ZIP, "start.cmd");
  if (/(^|[^\r])\n/.test(cmd) || /[^\x00-\x7f]/.test(cmd)) throw new Error("start.cmdがCRLFのASCIIになっていません");
}

function tar(...args: string[]): string {
  return execFileSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
