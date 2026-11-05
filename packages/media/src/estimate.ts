import { sumEstimate, type CostEstimate } from "@forge/shared";
import type { MediaJob } from "./types.js";
import { costForUnits, megapixels, priceFor, type ModelPrice } from "./pricing.js";

/** Units billed for a job under a price (megapixels / images / seconds). */
export function billedUnits(job: MediaJob, price: ModelPrice, billedSeconds?: number): number {
  switch (price.unit) {
    case "megapixel":
      return job.type === "text-to-image" ? megapixels(job.width, job.height, job.n) : 1;
    case "image":
      return job.type === "text-to-image" ? job.n : 1;
    case "second":
      return billedSeconds ?? ("durationSec" in job ? job.durationSec : 0);
  }
}

/** Shared estimate for priced (real) adapters. */
export function estimateFromTable(job: MediaJob, model: string, billedSeconds?: number): CostEstimate {
  const price = priceFor(model);
  const units = billedUnits(job, price, billedSeconds);
  const usd = costForUnits(price, units);
  return sumEstimate([{ label: `${model} × ${units} ${price.unit}${units === 1 ? "" : "s"}`, usd }], 0.1);
}
