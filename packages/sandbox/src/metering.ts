import { round4, type UsageSink } from "@forge/shared";

/**
 * Sandbox compute prices (USD).
 * - e2b: https://e2b.dev/pricing — $0.000014 per vCPU-second, $0.0000045 per GiB-second of RAM.
 * - daytona: https://www.daytona.io/pricing — $0.000014 per vCPU-second, $0.0000045 per GiB-second of RAM.
 * - docker (self-hosted): Hetzner Cloud CPX41 list price (8 shared vCPU, 16 GB, ~€0.044/h ≈ $0.047/h,
 *   https://www.hetzner.com/cloud) → ≈ $0.0059 per vCPU-hour, RAM included. Override with
 *   SANDBOX_DOCKER_USD_PER_VCPU_HOUR / SANDBOX_DOCKER_USD_PER_GB_HOUR for your own hardware.
 * - local: runs on the developer machine, no isolation, no cost.
 */
export interface SandboxRates {
  usdPerVcpuSecond: number;
  usdPerGibSecond: number;
}

export const RATES: Record<"e2b" | "daytona" | "local", SandboxRates> = {
  e2b: { usdPerVcpuSecond: 0.000014, usdPerGibSecond: 0.0000045 },
  daytona: { usdPerVcpuSecond: 0.000014, usdPerGibSecond: 0.0000045 },
  local: { usdPerVcpuSecond: 0, usdPerGibSecond: 0 },
};

export function dockerRates(): SandboxRates {
  const vcpuHour = Number(process.env.SANDBOX_DOCKER_USD_PER_VCPU_HOUR ?? "0.0059");
  const gbHour = Number(process.env.SANDBOX_DOCKER_USD_PER_GB_HOUR ?? "0");
  return { usdPerVcpuSecond: (Number.isFinite(vcpuHour) ? vcpuHour : 0.0059) / 3600, usdPerGibSecond: (Number.isFinite(gbHour) ? gbHour : 0) / 3600 };
}

export function sandboxCostUsd(seconds: number, cpu: number, memoryMb: number, rates: SandboxRates): number {
  return seconds * (cpu * rates.usdPerVcpuSecond + (memoryMb / 1024) * rates.usdPerGibSecond);
}

/** Tracks active time of one sandbox and records `sandbox_minutes` on pause/destroy. */
export class SandboxMeter {
  private activeSince: number | null;
  constructor(
    private readonly sink: UsageSink | undefined,
    private readonly info: { provider: string; projectId: string; cpu: number; memoryMb: number; rates: SandboxRates },
    activeSince: number | null = Date.now(),
  ) {
    this.activeSince = activeSince;
  }

  start(at = Date.now()): void {
    if (this.activeSince === null) this.activeSince = at;
  }

  /** Close the current active window (if any) and record it. */
  async stop(at = Date.now()): Promise<void> {
    if (this.activeSince === null) return;
    const seconds = Math.max(0, (at - this.activeSince) / 1000);
    this.activeSince = null;
    if (!this.sink) return;
    await this.sink.record({
      kind: "sandbox_minutes",
      quantity: round4(seconds / 60),
      // 8 decimals: short windows cost fractions of a cent.
      costUsd: Math.round(sandboxCostUsd(seconds, this.info.cpu, this.info.memoryMb, this.info.rates) * 1e8) / 1e8,
      provider: this.info.provider,
      projectId: this.info.projectId,
    });
  }
}
