// 配布ZIPに同梱するWindows（x64）用のnode.exeとLICENSEを公式から取得し、dist/node-<版>-win-x64/に置く。
// 取得済みでハッシュが一致すれば、node.exeは取り直さない。nr dist（scripts/dist.ts）から呼ぶ。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// 版を上げるときは、https://nodejs.org/dist/<版>/SHASUMS256.txt の win-x64/node.exe の値に合わせる
const VERSION = "v24.21.0";
const NODE_EXE_SHA256 = "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32";

const ROOT = path.join(import.meta.dirname, "..");

// node.exeとLICENSEを置いたディレクトリを返す
export async function fetchNode(): Promise<string> {
  const outDir = path.join(ROOT, "dist", `node-${VERSION}-win-x64`);
  const exe = path.join(outDir, "node.exe");
  const license = path.join(outDir, "LICENSE");
  mkdirSync(outDir, { recursive: true });

  if (!existsSync(exe) || sha256(readFileSync(exe)) !== NODE_EXE_SHA256) {
    const data = await get(`https://nodejs.org/dist/${VERSION}/win-x64/node.exe`);
    const actual = sha256(data);
    if (actual !== NODE_EXE_SHA256) throw new Error(`node.exeのハッシュが一致しません: ${actual}`);
    writeFileSync(exe, data);
  }
  // Node.jsを再配布するときはライセンス表記も同梱する
  if (!existsSync(license)) writeFileSync(license, await get(`https://raw.githubusercontent.com/nodejs/node/${VERSION}/LICENSE`));
  return outDir;
}

async function get(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`取得できません: ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
