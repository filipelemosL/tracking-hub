import { describe, expect, it } from "vitest";

import { formatSupportReport } from "../../src/application/support/format-support-report.js";

describe("support CLI report", () => {
  it("explains a webhook awaiting tracking without pretending an order exists", () => {
    const report = formatSupportReport({
      orderId: "pedido-pendente", processingStatus: "WAITING_TRACKING",
      webhookEvents: [{ eventId: "evt-1", status: "WAITING_TRACKING", reason: "TRACKING_PENDING", retryCount: 0,
        nextAttemptAt: "2026-11-08T12:00:01Z", trackingDeadline: "2026-11-08T12:00:10Z" }]
    });
    expect(report).toContain("SITUAÇÃO DO PEDIDO");
    expect(report).toContain("Situação: WAITING_TRACKING");
    expect(report).toContain("Venda: ainda não registrada");
    expect(report).toContain("prazo do tracking: 2026-11-08T12:00:10Z");
    expect(report).not.toContain("Conversões por provedor");
  });

  it("shows the chosen session, field origins and independent provider attempts", () => {
    const response = {
      order: { orderId: "pedido-1", amount: 25500, currency: "USD", occurredAt: "2026-11-08T12:00:00Z", timeSource: "OCCURRED_AT" },
      attribution: { status: "ATTRIBUTED", method: "SESSION_ID", reason: "SESSION_ID_MATCH", sessionId: "sessao-1",
        customFields: { campaign: "lancamento" }, identifiers: { gclid: "google-click" },
        evidence: { "customFields.campaign": { source: "WEBHOOK", sourceId: "evt-1", path: "customFields.campaign" },
          "identifiers.gclid": { source: "TRACKING_SESSION", sourceId: "sessao-1", path: "identifiers.gclid" } } },
      webhookEvents: [{ eventId: "evt-1", status: "PROCESSED", reason: null, retryCount: 0 }],
      deliveries: [
        { provider: "GOOGLE", status: "DELIVERED", transportMode: "SIMULATED", reason: null, conversionId: "conv-1", payloadSchemaVersion: "google-demo-v1",
          attempts: [{ attemptNumber: 1, status: "SUCCEEDED", startedAt: "2026-11-08T12:00:01Z", finishedAt: "2026-11-08T12:00:02Z", httpStatus: 200, errorCode: null, requestDigest: "a".repeat(64), request: { method: "POST" }, response: { accepted: true } }] },
        { provider: "META", status: "RETRY_PENDING", transportMode: "SIMULATED", reason: "SERVICE_UNAVAILABLE", conversionId: "conv-2", payloadSchemaVersion: "meta-demo-v1", nextAttemptAt: "2026-11-08T12:00:03Z",
          attempts: [{ attemptNumber: 1, status: "FAILED_RETRYABLE", startedAt: "2026-11-08T12:00:01Z", finishedAt: "2026-11-08T12:00:02Z", httpStatus: 503, errorCode: "SERVICE_UNAVAILABLE", requestDigest: "b".repeat(64), request: { method: "POST" }, response: { accepted: false } }] }
      ]
    };
    const report = formatSupportReport(response);
    expect(report).toContain("Venda: 25500 centavos (US$ 255,00) · USD");
    expect(report).toContain("COMO A VISITA FOI VINCULADA");
    expect(report).toContain("Sessão: sessao-1 · critério: SESSION_ID");
    expect(report).toContain("campaign: lancamento · origem: webhook evt-1");
    expect(report).toContain("gclid: google-click · origem: sessão sessao-1");
    expect(report).toContain("GOOGLE · DELIVERED (aceitação simulada)");
    expect(report).toContain("META · RETRY_PENDING");
    expect(report).toContain("HTTP: 503");
    expect(report).toContain("PONTOS PARA INVESTIGAR");
    expect(report).toContain("META: RETRY_PENDING · SERVICE_UNAVAILABLE · próxima tentativa: 2026-11-08T12:00:03Z");
    expect(report).not.toContain("request protegido:");
    expect(formatSupportReport(response, true)).toContain('request protegido: {"method":"POST"}');
  });
});
