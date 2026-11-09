type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const value = (item: unknown): string => item === null || item === undefined ? "—" : typeof item === "string" ? item : JSON.stringify(item);
const rule = "─".repeat(72);
const paint = (text: string, code: number, color: boolean) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
const heading = (text: string, color: boolean) => paint(text, 36, color);
const money = (amount: unknown, currency: unknown): string => {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || typeof currency !== "string") return `${value(amount)} centavos`;
  try {
    const formatted = new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(amount / 100).replace(/\u00a0/g, " ");
    return `${amount} centavos (${formatted})`;
  } catch { return `${amount} centavos`; }
};
const statusColor = (status: unknown, color: boolean): string => {
  const text = value(status);
  const code = text === "DELIVERED" || text === "PROCESSED" || text === "ATTRIBUTED" ? 32
    : text.startsWith("FAILED") || text === "CONFLICT" ? 31 : 33;
  return paint(text, code, color);
};

const reasons: Record<string, string> = {
  NO_MATCH: "sem evidência suficiente para vincular uma sessão",
  SESSION_NOT_FOUND: "sessão informada não encontrada até o prazo",
  SESSION_AFTER_ORDER: "sessão capturada depois da compra",
  AMBIGUOUS_CUSTOMER_MATCH: "mais de uma sessão elegível para o cliente",
  MISSING_CLICK_ID: "Google sem gclid, gbraid ou wbraid",
  MISSING_REDTRACK_CLICK_ID: "RedTrack sem seu click ID",
  MISSING_MATCHING_DATA: "URL ou sinal de matching insuficiente",
  ORDER_DATA_CONFLICT: "novo evento diverge do pedido preservado",
  TRANSPORT_TIMEOUT: "aceitação incerta após timeout",
  LEASE_EXPIRED: "tentativa sem confirmação após perda da posse"
};

function reason(item: unknown): string {
  if (typeof item !== "string") return "—";
  return reasons[item] ? `${item} (${reasons[item]})` : item;
}

function appendEvents(lines: string[], events: unknown, color: boolean): void {
  lines.push("", heading("ANDAMENTO DO PROCESSAMENTO", color));
  const rows = list(events);
  if (rows.length === 0) { lines.push("  nenhum"); return; }
  for (const raw of rows) {
    const event = record(raw);
    lines.push(`  ${value(event.eventId)} · ${statusColor(event.status, color)} · motivo: ${reason(event.reason)} · retries: ${value(event.retryCount)}`);
    if ((event.status === "PENDING" || event.status === "WAITING_TRACKING") && event.nextAttemptAt) {
      lines.push(`    próxima tentativa: ${value(event.nextAttemptAt)}`);
    }
    if (event.trackingDeadline) lines.push(`    prazo do tracking: ${value(event.trackingDeadline)}`);
    if (event.error) lines.push(`    erro: ${value(event.error)}`);
  }
}

function appendFields(lines: string[], title: string, group: "customFields" | "identifiers", fields: unknown, evidence: RecordValue): void {
  lines.push(`  ${title}:`);
  const entries = Object.entries(record(fields));
  if (entries.length === 0) { lines.push("    nenhum"); return; }
  for (const [name, fieldValue] of entries) {
    const path = `${group}.${name}`;
    const origin = record(evidence[path]);
    const source = origin.source === "TRACKING_SESSION" ? "sessão" : origin.source === "WEBHOOK" ? "webhook" : "origem não comprovada";
    const id = origin.sourceId ? ` ${value(origin.sourceId)}` : "";
    lines.push(`    ${name}: ${value(fieldValue)} · origem: ${source}${id}${origin.path ? ` (${value(origin.path)})` : ""}`);
  }
}

function appendAttention(lines: string[], result: RecordValue, attribution: RecordValue, color: boolean): void {
  const items: string[] = [];
  if (attribution.status !== "ATTRIBUTED") {
    items.push(`Vínculo da visita: ${reason(attribution.reason)} (estado: ${value(attribution.status)})`);
  }
  for (const raw of list(result.webhookEvents)) {
    const event = record(raw);
    if (event.status !== "PROCESSED") {
      items.push(`Evento ${value(event.eventId)}: ${value(event.status)} · ${reason(event.reason)}${event.nextAttemptAt ? ` · próxima tentativa: ${value(event.nextAttemptAt)}` : ""}`);
    }
  }
  for (const raw of list(result.deliveries)) {
    const delivery = record(raw);
    if (delivery.status !== "DELIVERED") {
      items.push(`${value(delivery.provider)}: ${value(delivery.status)} · ${reason(delivery.reason)}${delivery.nextAttemptAt ? ` · próxima tentativa: ${value(delivery.nextAttemptAt)}` : ""}`);
    }
  }
  lines.push("", heading("PONTOS PARA INVESTIGAR", color));
  lines.push(...(items.length ? items.map((item) => `  • ${item}`) : ["  Nenhum bloqueio registrado."]));
}

export function formatSupportReport(body: unknown, showPayload = false, color = false): string {
  const result = record(body);
  const order = record(result.order);
  const attribution = record(result.attribution);
  const lines: string[] = [paint("TRACKING HUB  /  CONSULTA DE SUPORTE", 1, color), rule];
  if (!result.order) {
    lines.push("", heading("SITUAÇÃO DO PEDIDO", color));
    lines.push(`Pedido: ${value(result.orderId)}`);
    lines.push("Venda: ainda não registrada");
    lines.push(`Situação: ${statusColor(result.processingStatus, color)}`);
    appendEvents(lines, result.webhookEvents, color);
    lines.push("", rule);
    return lines.join("\n");
  }
  lines.push("", heading("SITUAÇÃO DO PEDIDO", color));
  lines.push(`Pedido: ${value(order.orderId)}`);
  lines.push(`Venda: ${money(order.amount, order.currency)} · ${value(order.currency)}`);
  lines.push(`Data da venda: ${value(order.occurredAt)} · origem da data: ${value(order.timeSource)}`);
  lines.push("", heading("COMO A VISITA FOI VINCULADA", color));
  lines.push(`Decisão: ${statusColor(attribution.status, color)} · ${reason(attribution.reason)}`);
  lines.push(`Sessão: ${attribution.sessionId ? value(attribution.sessionId) : "nenhuma"} · critério: ${value(attribution.method)}`);
  const evidence = record(attribution.evidence);
  appendFields(lines, "Dados de campanha", "customFields", attribution.customFields, evidence);
  appendFields(lines, "Sinais de identificação", "identifiers", attribution.identifiers, evidence);
  appendEvents(lines, result.webhookEvents, color);
  lines.push("", heading("RESULTADO DOS ENVIOS", color));
  const deliveries = list(result.deliveries);
  const accepted = deliveries.filter((item) => record(item).status === "DELIVERED").length;
  const skipped = deliveries.filter((item) => record(item).status === "SKIPPED").length;
  lines.push(`  ${accepted} aceitos · ${skipped} não enviados · ${deliveries.length - accepted - skipped} pendentes ou com falha`);
  if (deliveries.length === 0) lines.push("  nenhuma");
  for (const raw of deliveries) {
    const delivery = record(raw);
    const simulated = delivery.transportMode === "SIMULATED" && delivery.status === "DELIVERED" ? " (aceitação simulada)" : "";
    lines.push("", `  ${paint("●", 36, color)} ${value(delivery.provider)} · ${statusColor(delivery.status, color)}${simulated} · motivo: ${reason(delivery.reason)}`);
    lines.push(`    conversão: ${value(delivery.conversionId)} · contrato: ${value(delivery.payloadSchemaVersion)}`);
    if (delivery.nextAttemptAt) lines.push(`    próxima tentativa: ${value(delivery.nextAttemptAt)}`);
    for (const rawAttempt of list(delivery.attempts)) {
      const attempt = record(rawAttempt);
      lines.push(`    #${value(attempt.attemptNumber)} ${value(attempt.status)} · início: ${value(attempt.startedAt)} · fim: ${value(attempt.finishedAt)} · HTTP: ${value(attempt.httpStatus)} · erro: ${value(attempt.errorCode)}`);
      lines.push(`      digest: ${value(attempt.requestDigest)}`);
      if (showPayload) {
        lines.push(`      request protegido: ${JSON.stringify(attempt.request)}`);
        lines.push(`      resposta protegida: ${JSON.stringify(attempt.response)}`);
      }
    }
  }
  appendAttention(lines, result, attribution, color);
  lines.push("", rule, "Observação: DELIVERED com SIMULATED não confirma presença no painel da plataforma.");
  return lines.join("\n");
}
