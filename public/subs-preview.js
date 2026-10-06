// 設定パネルの「表示」のプレビュー。OBSの画面（1920×1080と仮定）に見本の字幕を出し、枠の幅に縮小して見せる。
import { createSubs } from "./overlay.js";

const CANVAS_WIDTH = 1920;
const SAMPLES = [
  { text: "みなさんこんばんは、今日も来てくれてありがとう。", en: "Good evening, everyone. Thanks for coming again today." },
  { text: "今日は新しいゲームを最後までやっていきます。", en: "Today I'm going to play a new game all the way to the end." },
  { text: "コメントもどんどん書いてくださいね。", en: "Please keep the comments coming." },
];
const PARTIAL_TEXT = "それじゃあさっそく始めていき";

/**
 * @param {HTMLElement} box
 * @returns {(values: Record<string, unknown>, styleVars: Record<string, string>) => void} 設定の値で描画し直す関数
 */
export function mountPreview(box) {
  const canvas = document.createElement("div");
  canvas.className = "cap-preview-canvas";
  box.append(canvas);
  const subs = createSubs(canvas);
  /** @type {Set<string>} */
  let styleKeys = new Set();
  // transformを持つ要素がposition: fixedの基準になるので、.nm-subsはこの画面の下端に付く
  new ResizeObserver(() => {
    canvas.style.transform = `scale(${box.clientWidth / CANVAS_WIDTH})`;
  }).observe(box);

  return function update(values, styleVars) {
    // 設定パネルで変えたCSS変数だけをこの画面に当てる。未設定ならoverlay.cssの値を継ぐ
    for (const [name, value] of Object.entries(styleVars)) canvas.style.setProperty(name, value);
    for (const name of styleKeys) if (!(name in styleVars)) canvas.style.removeProperty(name);
    styleKeys = new Set(Object.keys(styleVars));
    // 最後の1文は途中経過（薄い色）で見せる
    const count = Math.max(1, Number(values.displaySegments) || 1);
    const segments = [];
    for (let i = 0; i < count - 1; i++) {
      const sample = SAMPLES[i % SAMPLES.length];
      segments.push({ id: `fixed-${i}`, state: "fixed", text: sample.text, en: sample.en });
    }
    segments.push({ id: "partial", state: "partial", text: PARTIAL_TEXT });
    subs.render(segments);
  };
}
