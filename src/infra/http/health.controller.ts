import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";

import { InMemoryMetrics } from "../../observability";
import { MetricsReporter } from "../metrics-reporter";
import { LifecycleState } from "../shutdown";
import { Public } from "./auth";

export const READINESS_CHECKS = Symbol("READINESS_CHECKS");

export interface ReadinessCheck {
  name: string;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<unknown>;
}

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, "up" | "down">;
}

async function runCheck({ run, timeoutMs }: ReadinessCheck): Promise<"up" | "down"> {
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    await Promise.race([run(signal), timedOut]);
    return "up";
  } catch {
    return "down";
  }
}

export async function runChecks(checks: ReadinessCheck[]): Promise<ReadinessReport> {
  const results = await Promise.all(checks.map(runCheck));
  const report: ReadinessReport = { ok: results.every((result) => result === "up"), checks: {} };
  checks.forEach((check, index) => {
    report.checks[check.name] = results[index]!;
  });
  return report;
}

@Controller("health")
@Public()
export class HealthController {
  constructor(
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[],
    private readonly lifecycle: LifecycleState,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    if (this.lifecycle.draining) throw new ServiceUnavailableException({ status: "unavailable", draining: true });
    const report = await runChecks(this.checks);
    if (!report.ok) throw new ServiceUnavailableException({ status: "unavailable", checks: report.checks });
    return { status: "ok", checks: report.checks };
  }
}

@Controller("metrics")
@Public()
export class MetricsController {
  constructor(
    private readonly metrics: InMemoryMetrics,
    private readonly reporter: MetricsReporter,
  ) {}

  @Get()
  async snapshot() {
    await this.reporter.sample();
    return this.metrics.snapshot();
  }
}
