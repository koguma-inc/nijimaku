// OS標準のbsdtarの絶対パスを返す。PATHのtarはGNU tar（Git for Windows・Homebrew等）に解決されることがあり、
// GNU tarはZIPを扱えないので、パスを決め打ちする。
import path from "node:path";

export function bsdtarPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") return path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  if (platform === "darwin") return "/usr/bin/tar";
  throw new Error(`このOSには対応していません: ${platform}`);
}
