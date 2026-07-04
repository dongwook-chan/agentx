import { stat } from "node:fs/promises";
import { IncrementalFileTail } from "@dong-/agentx-core";
import { createQuotaSummary, finalizeQuotaSummary, ingestQuotaLine, parseQuotaTriggerLine } from "./quota.js";

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
    this.tail = new IncrementalFileTail(file, options);
    this.summary = createQuotaSummary();
    this.summary.scannedFiles = 1;
  }

  async readAdded() {
    const info = await stat(this.file).catch(() => undefined);
    if (!info) return undefined;
    if (info.size < this.tail.offset) {
      this.summary = createQuotaSummary();
      this.summary.scannedFiles = 1;
    }
    const added = await this.tail.readAdded();
    if (!added) return undefined;

    let changed = false;
    let quotaTrigger;
    const startingLine = added.lineNumber - added.lines.length;
    let lineNumber = startingLine;
    for (const line of added.lines) {
      lineNumber += 1;
      if (!line) continue;
      if (ingestQuotaLine(this.summary, this.file, lineNumber, line)) changed = true;
      quotaTrigger = quotaTrigger ?? parseQuotaTriggerLine(line);
    }
    if (!changed && !quotaTrigger) return undefined;
    const summary = cloneFinalSummary(this.summary);
    if (quotaTrigger) summary.quotaTrigger = quotaTrigger;
    return summary;
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
