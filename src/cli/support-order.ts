import { formatSupportReport } from "../application/support/format-support-report.js";

const usage = `Uso: npm run support:order -- <orderId> [--base-url http://localhost:3000] [--json] [--show-payload]

Consulta GET /support/orders/:orderId/tracking. --show-payload mostra o request e a resposta já protegidos pela API.
TRACKING_HUB_BASE_URL define a URL padrão da API.`;

type Options = { orderId: string; baseUrl: string; json: boolean; showPayload: boolean };

function parseArgs(args: string[]): Options | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  let orderId: string | undefined;
  let baseUrl = process.env.TRACKING_HUB_BASE_URL ?? "http://localhost:3000";
  let json = false;
  let showPayload = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--show-payload") showPayload = true;
    else if (arg === "--base-url") {
      baseUrl = args[++index] ?? "";
      if (!baseUrl) throw new Error("Informe uma URL após --base-url.");
    } else if (arg?.startsWith("-")) throw new Error(`Opção desconhecida: ${arg}`);
    else if (orderId) throw new Error("Informe apenas um orderId.");
    else orderId = arg;
  }
  if (!orderId || !orderId.trim() || orderId.length > 128) throw new Error("Informe um orderId válido (1 a 128 caracteres).");
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error("--base-url deve ser uma URL HTTP válida."); }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error("--base-url deve ser HTTP(S) e não pode conter credenciais.");
  }
  return { orderId: orderId.trim(), baseUrl: parsed.origin, json, showPayload };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) { console.log(usage); return; }
  const url = `${options.baseUrl}/support/orders/${encodeURIComponent(options.orderId)}/tracking`;
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  const body: unknown = await response.json();
  if (!response.ok) {
    const code = body && typeof body === "object" && "code" in body ? String(body.code) : `HTTP_${response.status}`;
    throw new Error(`Consulta falhou: ${code} (HTTP ${response.status}).`);
  }
  const color = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
  console.log(options.json ? JSON.stringify(body, null, 2) : formatSupportReport(body, options.showPayload, color));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Falha desconhecida na consulta.");
  process.exitCode = 1;
});
