import { open, stat } from "node:fs/promises";
import { createQuotaSummary, finalizeQuotaSummary, ingestQuotaLine } from "./quota.js";

function cloneFinalSummary(summary) {
  return finalizeQuotaSummary({
    ...summary,
    reachedTypes: new Set(summary.reachedTypes instanceof Set ? summary.reachedTypes : summary.reachedTypes ?? []),
    highWatermarks: [...summary.highWatermarks],
  });
}

export class QuotaTail {
  constructor(file, options = {}) {
    this.file = file;
    this.offset = options.offset ?? 0;
    this.carry = "";
    this.lineNumber = options.lineNumber ?? 0;
    this.summary = createQuotaSummary();
    this.summary.scannedFiles = 1;
  }

  async readAdded() {
    const info = await stat(this.file).catch(() => undefined);
    if (!info) return undefined;
    if (info.size < this.offset) {
      this.offset = 0;
      this.carry = "";
      this.lineNumber = 0;
      this.summary = createQuotaSummary();
      this.summary.scannedFiles = 1;
    }
    if (info.size === this.offset) return undefined;

    const size = info.size - this.offset;
    const buffer = Buffer.alloc(size);
    const handle = await open(this.file, "r");
    try {
      await handle.read(buffer, 0, size, this.offset);
    } finally {
      await handle.close();
    }
    this.offset = info.size;

    const text = this.carry + buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    this.carry = text.endsWith("\n") || text.endsWith("\r") ? "" : (lines.pop() ?? "");

    let changed = false;
    for (const line of lines) {
      this.lineNumber += 1;
      if (line && ingestQuotaLine(this.summary, this.file, this.lineNumber, line)) changed = true;
    }
    return changed ? cloneFinalSummary(this.summary) : undefined;
  }
}

export async function wait(ms, signal) {
  if (signal?.aborted) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}
