import { cpus, release, totalmem } from "node:os";
import { formatCents, seededRandom, summarize, type Summary } from "./load-stats";

const argv = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key!, value] as const;
  }),
);
const quick = argv.has("quick");
const number = (key: string, normal: number, small: number) => Number(argv.get(key) ?? (quick ? small : normal));

const URLS = (argv.get("urls") ?? "http://localhost:3001,http://localhost:3002,http://localhost:3003").split(",");
const WALLETS = number("wallets", 100, 20);
const ROUNDS = number("rounds", 1500, 150);
const HOT_REQUESTS = number("hot", 500, 100);
const LATE_ROUNDS = number("late", 40, 10);
const CONCURRENCY = number("concurrency", 60, 30);
const DUPLICATE_RATE = Number(argv.get("duplicates") ?? 0.1);
const SEED = Number(argv.get("seed") ?? 1);
const OUT = argv.get("out") ?? "docs/load-test-results.md";
const MAX_ATTEMPTS = 20;
const INITIAL_CENTS = 10_000_000n;

const random = seededRandom(SEED);
const run = Date.now().toString(36);
const json = { "content-type": "application/json" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Wallet {
  playerId: string;
  walletId: string;
  expected: bigint;
}

interface LateJob {
  wallet: Wallet;
  betExternal: string;
  betCents: bigint;
  refundExternal: string;
  resolvedMs?: number;
}

interface Sample {
  phase: string;
  kind: string;
  ms: number;
  attempts: number;
  status: number;
  ok: boolean;
}

const samples: Sample[] = [];
const phaseWall = new Map<string, number>();
const failures = new Map<string, number>();
let nextInstance = 0;

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, instance = nextInstance++) {
  const response = await fetch(`${URLS[instance % URLS.length]}${path}`, {
    method,
    headers: { ...json, ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function createWallet(): Promise<Wallet> {
  const playerId = crypto.randomUUID();
  const created = await http("POST", "/wallets", { playerId, initialBalance: { amount: formatCents(INITIAL_CENTS), currency: "BRL" } });
  if (created.status !== 201) throw new Error(`could not create a wallet: ${created.status}`);
  return { playerId, walletId: created.body.id, expected: INITIAL_CENTS };
}

interface Spec {
  external: string;
  kind: "BET" | "WIN" | "LOSS" | "REFUND";
  cents: bigint;
  reference?: string;
  expectStatus?: number;
  expectReplay?: boolean;
}

async function submit(phase: string, wallet: Wallet, spec: Spec): Promise<Record<string, any>> {
  const { external, kind, cents, reference, expectStatus = 200, expectReplay } = spec;
  const payload = {
    providerId: "provider-load",
    externalTransactionId: external,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "load",
    gameId: "load",
    kind,
    money: { amount: formatCents(cents), currency: "BRL" },
    ...(reference && { referenceExternalTransactionId: reference }),
  };
  const started = performance.now();
  let attempts = 0;
  let reply: { status: number; body: Record<string, any> } | undefined;
  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    reply = await http("POST", "/wagering/transactions", payload, { "idempotency-key": external }).catch(() => undefined);
    if (reply && reply.status < 500) break;
    await sleep(50);
  }
  const status = reply?.status ?? 0;
  const ok = status === expectStatus && (expectReplay === undefined || reply?.body.idempotentReplay === expectReplay);
  if (!ok) failures.set(`${phase} ${kind} -> ${status}`, (failures.get(`${phase} ${kind} -> ${status}`) ?? 0) + 1);
  samples.push({ phase, kind, ms: performance.now() - started, attempts, status, ok });
  return reply?.body ?? {};
}

async function pool<T>(items: T[], work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) await work(items[index]!, index);
    }),
  );
}

async function phase(name: string, work: () => Promise<void>) {
  const started = performance.now();
  await work();
  phaseWall.set(name, (performance.now() - started) / 1000);
  console.log(`  ${name}: ${samples.filter((s) => s.phase === name).length} requests in ${phaseWall.get(name)!.toFixed(2)} s`);
}

const randomCents = (min: number, max: number) => BigInt(Math.floor(random() * (max - min + 1)) + min) * 100n;

async function metrics() {
  const all = await Promise.all(URLS.map((url) => fetch(`${url}/metrics`).then((r) => r.json() as Promise<any>)));
  const counters = new Map<string, number>();
  for (const snapshot of all) {
    for (const [key, value] of Object.entries(snapshot.counters as Record<string, number>)) {
      counters.set(key, (counters.get(key) ?? 0) + value);
    }
  }
  return { all, counters };
}

const sumCounters = (counters: Map<string, number>, prefix: string) =>
  [...counters].filter(([key]) => key.startsWith(prefix)).reduce((total, [, value]) => total + value, 0);

async function git(...args: string[]) {
  try {
    const process = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" });
    return (await new Response(process.stdout).text()).trim();
  } catch {
    return "";
  }
}

async function main() {
  console.log(`Load test against ${URLS.join(", ")}  (seed ${SEED}${quick ? ", quick" : ""})`);
  const before = await metrics();
  const startedAt = new Date();

  let wallets: Wallet[] = [];
  let hot!: Wallet;
  const late: LateJob[] = [];

  await phase("setup", async () => {
    const created = await Promise.all([...Array.from({ length: WALLETS }, createWallet), createWallet()]);
    hot = created.pop()!;
    wallets = created;
  });

  await phase("muitas wallets", async () => {
    await pool(Array.from({ length: ROUNDS }, (_, n) => n), async (n) => {
      const wallet = wallets[n % wallets.length]!;
      const bet: Spec = { external: `${run}-r${n}-bet`, kind: "BET", cents: randomCents(1, 20) };
      await submit("muitas wallets", wallet, bet);
      wallet.expected -= bet.cents;
      if (random() < DUPLICATE_RATE) await submit("muitas wallets", wallet, { ...bet, expectReplay: true });

      const wins = random() < 0.7;
      const settle: Spec = wins
        ? { external: `${run}-r${n}-win`, kind: "WIN", cents: randomCents(1, 40), reference: bet.external }
        : { external: `${run}-r${n}-loss`, kind: "LOSS", cents: 0n, reference: bet.external };
      await submit("muitas wallets", wallet, settle);
      if (wins) wallet.expected += settle.cents;
    });
  });

  await phase("wallet quente", async () => {
    await pool(Array.from({ length: HOT_REQUESTS }, (_, n) => n), async (n) => {
      await submit("wallet quente", hot, { external: `${run}-hot-${n}`, kind: "BET", cents: 100n });
      hot.expected -= 100n;
    });
  });

  await phase("fora de ordem", async () => {
    const pendingJobs: LateJob[] = Array.from({ length: LATE_ROUNDS }, (_, n) => ({
      wallet: wallets[n % wallets.length]!,
      betExternal: `${run}-late-${n}-bet`,
      betCents: randomCents(1, 20),
      refundExternal: `${run}-late-${n}-refund`,
    }));
    late.push(...pendingJobs);
    await pool(pendingJobs, async (job) => {
      await submit("fora de ordem", job.wallet, {
        external: job.refundExternal,
        kind: "REFUND",
        cents: job.betCents,
        reference: job.betExternal,
        expectStatus: 202,
      });
      await submit("fora de ordem", job.wallet, { external: job.betExternal, kind: "BET", cents: job.betCents });
      const waitingSince = performance.now();
      while (performance.now() - waitingSince < 30_000) {
        const lookup = await http("GET", `/providers/provider-load/wagering/transactions/${job.refundExternal}`);
        if (lookup.body.status === "PROCESSED") {
          job.resolvedMs = performance.now() - waitingSince;
          break;
        }
        await sleep(100);
      }
    });
  });

  const drainStarted = performance.now();
  let drained = false;
  while (performance.now() - drainStarted < 60_000) {
    const state = await fetch(`${URLS[0]}/metrics`).then((r) => r.json() as Promise<any>);
    if (state.gauges.outbox_pending === 0) {
      drained = true;
      break;
    }
    await sleep(200);
  }
  const drainSeconds = (performance.now() - drainStarted) / 1000;

  const everyWallet = [...wallets, hot];
  let balanceMismatches = 0;
  let consistent = 0;
  await Promise.all(
    everyWallet.map(async (wallet) => {
      const balance = (await http("GET", `/wallets/${wallet.walletId}`)).body.balance.amount;
      if (balance !== formatCents(wallet.expected)) balanceMismatches++;
      if ((await http("POST", `/wallets/${wallet.walletId}/reconciliation`, {})).body.consistent) consistent++;
    }),
  );

  const after = await metrics();
  const delta = (prefix: string) => sumCounters(after.counters, prefix) - sumCounters(before.counters, prefix);
  const lag = Math.max(...after.all.map((s: any) => s.gauges.outbox_lag_seconds ?? 0));
  const lockWait = after.all.map((s: any) => s.histograms.wallet_lock_wait_seconds).filter(Boolean);

  const phases = ["muitas wallets", "wallet quente", "fora de ordem"];
  const rows = phases.map((name) => {
    const mine = samples.filter((s) => s.phase === name);
    const stats = summarize(mine.map((s) => s.ms));
    const errors = mine.filter((s) => !s.ok).length;
    const retries = mine.reduce((total, s) => total + s.attempts - 1, 0);
    return { name, stats, errors, retries, count: mine.length, throughput: mine.length / (phaseWall.get(name) ?? 1) };
  });
  const everything = summarize(samples.map((s) => s.ms));
  const totalErrors = samples.filter((s) => !s.ok).length;
  const resolved = late.filter((job) => job.resolvedMs !== undefined);
  const resolveStats = summarize(resolved.map((job) => job.resolvedMs!));

  const ms = (value: number) => value.toFixed(1);
  const table = (stats: Summary) => `${ms(stats.p50)} | ${ms(stats.p90)} | ${ms(stats.p95)} | ${ms(stats.p99)} | ${ms(stats.max)}`;
  const commit = await git("rev-parse", "--short", "HEAD");
  const dirty = (await git("status", "--porcelain")) ? " (com alterações não commitadas)" : "";
  const compose = await Bun.file("docker-compose.yml").text().catch(() => "");
  const images = [...compose.matchAll(/^\s+image:\s+(\S+)/gm)].map((m) => m[1]).filter((name) => !name!.startsWith("wagering-app"));
  const cpu = cpus();

  const report = `# Resultado do teste de carga

Gerado por \`bun run test:load\` em ${startedAt.toISOString()}.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | ${cpu[0]?.model ?? "?"}, ${cpu.length} CPUs lógicas, ${(totalmem() / 1024 ** 3).toFixed(1)} GB de RAM |
| Sistema | ${release()} |
| Bun | ${Bun.version} |
| Commit | ${commit || "?"}${dirty} |
| Instâncias da aplicação | ${URLS.length} (${URLS.join(", ")}), cada uma com todos os papéis |
| Infraestrutura | ${images.join(", ") || "?"} (Docker Compose, na mesma máquina) |

## Método

- O gerador de carga roda na mesma máquina da aplicação, do Postgres e do LocalStack, então os números absolutos **não** representam um ambiente de produção. Vale comparar as fases entre si.
- ${WALLETS} wallets com saldo inicial alto (para que não haja rejeição por saldo) e 1 wallet quente. Semente aleatória: ${SEED}. Concorrência: ${CONCURRENCY} requisições em voo. As requisições se espalham em rodízio pelas ${URLS.length} instâncias.
- **muitas wallets:** ${ROUNDS} rodadas (\`BET\` e depois \`WIN\` ou \`LOSS\` referenciando a aposta, 70% / 30%). Cerca de ${(DUPLICATE_RATE * 100).toFixed(0)}% das apostas são reenviadas com a mesma chave e devem voltar como replay.
- **wallet quente:** ${HOT_REQUESTS} apostas de 1,00 na mesma wallet, todas em paralelo.
- **fora de ordem:** ${LATE_ROUNDS} \`REFUND\` enviados antes da sua \`BET\` (esperado: \`202\`); mede o tempo até o worker resolver.
- Um \`503\` ou erro de rede é reenviado com a mesma \`Idempotency-Key\` (até ${MAX_ATTEMPTS} vezes), como o contrato pede ao provedor. A latência de cada requisição inclui as tentativas.
- Os percentis são **exatos**, calculados sobre o tempo de cada requisição medido no cliente (nearest-rank).

## Resultados por fase

| Fase | Requisições | Req/s | p50 (ms) | p90 | p95 | p99 | máx | Erros | Retries |
|---|---|---|---|---|---|---|---|---|---|
${rows.map((row) => `| ${row.name} | ${row.count} | ${row.throughput.toFixed(0)} | ${table(row.stats)} | ${row.errors} | ${row.retries} |`).join("\n")}
| **total** | ${samples.length} | | ${table(everything)} | ${totalErrors} | ${samples.reduce((t, s) => t + s.attempts - 1, 0)} |

Taxa de erro: ${((totalErrors / Math.max(1, samples.length)) * 100).toFixed(2)}%. Um erro é qualquer resposta diferente da esperada naquela fase.
${failures.size > 0 ? `\nErros por tipo: ${[...failures].map(([key, value]) => `${key} (${value})`).join(", ")}.\n` : ""}
## Referências fora de ordem

${resolved.length} de ${late.length} \`REFUND\` foram resolvidos pelo worker. Tempo entre a chegada da \`BET\` e o \`REFUND\` ficar \`PROCESSED\` (ms): p50 ${ms(resolveStats.p50)}, p95 ${ms(resolveStats.p95)}, máx ${ms(resolveStats.max)}.

## Do lado do servidor

| Métrica | Valor |
|---|---|
| Transações novas processadas (contador, soma das instâncias, durante o teste) | ${delta("wager_transactions_total")} |
| Replays idempotentes | ${delta("idempotent_replays_total")} |
| Retries internos do caso de uso | ${delta("use_case_retries_total")} |
| Conflitos de lock (deadlock ou lock timeout) | ${delta("lock_conflicts_total")} |
| Espera pelo lock da wallet (desde o início das instâncias) | ${lockWait.length === 0 ? "?" : `p99 estimado (por bucket) até ${ms(Math.max(...lockWait.map((h: any) => h.p99)) * 1000)} ms, máx ${ms(Math.max(...lockWait.map((h: any) => h.max)) * 1000)} ms`} |
| Atraso da outbox no fim (\`outbox_lag_seconds\`) | ${lag} s |
| Tempo para a outbox esvaziar depois da carga | ${drained ? `${drainSeconds.toFixed(1)} s` : "não esvaziou em 60 s"} |
| Mensagens na DLQ | ${Math.max(...after.all.map((s: any) => s.gauges.sqs_dlq_depth ?? 0))} |

## Correção depois da carga

- Wallets conferidas: ${everyWallet.length}. Reconciliação consistente: **${consistent} de ${everyWallet.length}**.
- Saldo diferente do esperado pelo cliente (saldo inicial menos apostas mais ganhos): **${balanceMismatches}**.

## Limitações deste teste

- Gerador e sistema compartilham CPU, memória e disco; o Docker em laptop e o LocalStack não são o ambiente real.
- Não há aquecimento separado das medições nem repetição para medir variância. Rode mais de uma vez para ver a variação.
- A fase "wallet quente" mostra o custo do lock por wallet: as operações da mesma wallet são sequenciais.
- Os contadores do servidor são por instância e somados aqui. Os percentis do servidor são estimativas por bucket; os percentis da tabela acima são os exatos.
`;

  await Bun.write(OUT, report);

  console.log(`\n${samples.length} requests, ${totalErrors} errors, p50 ${ms(everything.p50)} ms, p95 ${ms(everything.p95)} ms, p99 ${ms(everything.p99)} ms`);
  console.log(`wallets consistent: ${consistent}/${everyWallet.length}, balance mismatches: ${balanceMismatches}, outbox drained: ${drained}`);
  console.log(`report: ${OUT}`);
  if (totalErrors > 0 || balanceMismatches > 0 || consistent !== everyWallet.length) process.exit(1);
}

await main();
