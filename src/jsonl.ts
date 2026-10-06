// LLMの出力が形式を外れても止まらないよう、解析できない行は捨てる。
function parseLine(rawLine: string): Record<string, unknown> | null {
  const line = rawLine.trim();
  if (line === "" || line.startsWith("```")) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export class JsonLineParser {
  private buffer = "";

  push(delta: string): Record<string, unknown>[] {
    this.buffer += delta;
    const results: Record<string, unknown>[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const obj = parseLine(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
      if (obj !== null) results.push(obj);
    }
    return results;
  }

  end(): Record<string, unknown>[] {
    const obj = parseLine(this.buffer);
    this.buffer = "";
    return obj === null ? [] : [obj];
  }
}
