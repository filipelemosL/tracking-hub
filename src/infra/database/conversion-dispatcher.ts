import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { createConversionProviders, protectTransportData, requestDigest, type ConversionEvent, type ConversionScenario, type LogicalRequest, type ProviderName, type ProviderResult } from "../../application/conversions/providers.js";

export type DispatcherConfig = { transportTimeoutMs: number; deliveryLeaseMs: number; deliveryMaxAttempts: number };
export type DispatcherHooks = { afterTransport?: () => Promise<void> };

function retryDelay(result: ProviderResult, attemptNumber: number, now: Date): number {
  if (result.httpStatus === 429 && result.retryAfter) {
    const seconds = Number(result.retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(result.retryAfter);
    if (Number.isFinite(date) && date > now.getTime()) return date - now.getTime();
  }
  return attemptNumber === 1 ? 1000 : 3000;
}

export function createConversionDispatcher(prisma: PrismaClient, config: DispatcherConfig, now: () => Date = () => new Date(), hooks: DispatcherHooks = {}) {
  const providers = createConversionProviders(config.transportTimeoutMs);
  async function runOnce(): Promise<boolean> {
    const cycleTime = now();
    const expired = await prisma.conversionDelivery.findFirst({ where: { status: "PROCESSING", leaseUntil: { lte: cycleTime } }, orderBy: { leaseUntil: "asc" } });
    if (expired) {
      await prisma.$transaction(async (tx) => {
        const changed = await tx.conversionDelivery.updateMany({ where: { id: expired.id, status: "PROCESSING", claimToken: expired.claimToken, leaseUntil: { lte: cycleTime } }, data: { status: "UNKNOWN", reason: "LEASE_EXPIRED", claimToken: null, leaseUntil: null, nextAttemptAt: null } });
        if (changed.count) await tx.conversionAttempt.updateMany({ where: { deliveryId: expired.id, status: "STARTED" }, data: { status: "UNKNOWN", finishedAt: cycleTime, errorCode: "LEASE_EXPIRED" } });
      });
      return true;
    }
    const delivery = await prisma.conversionDelivery.findFirst({ where: { status: { in: ["PENDING", "RETRY_PENDING"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: cycleTime } }] }, include: { order: { include: { trackingSession: true } }, attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } }, orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }] });
    if (!delivery) return false;
    const order = delivery.order;
    const attribution = order.attribution as { identifiers?: Record<string, string>; customFields?: Record<string, unknown> };
    const savedContext = order.conversionContext as { pageUrl?: string | null; emailHash?: string | null; phoneHash?: string | null; source?: string } | null;
    const context = savedContext ?? { pageUrl: order.trackingSession?.pageUrl ?? null, emailHash: order.trackingSession?.customerEmailHash ?? null, phoneHash: order.trackingSession?.customerPhoneHash ?? null, source: "LEGACY_DERIVED" };
    const attemptNumber = (delivery.attempts[0]?.attemptNumber ?? 0) + 1;
    const event: ConversionEvent = { provider: delivery.provider as ProviderName, orderId: order.orderId, conversionId: delivery.conversionId, occurredAt: order.occurredAt, amountInCents: order.amount, currency: order.currency, attribution: { identifiers: attribution.identifiers ?? {}, customFields: attribution.customFields ?? {} }, context, scenario: delivery.scenario as ConversionScenario, attemptNumber };
    const provider = providers[event.provider];
    const prepared = provider.prepare(event);
    if (prepared.skipReason && !delivery.frozenRequest) {
      await prisma.conversionDelivery.updateMany({ where: { id: delivery.id, status: delivery.status }, data: { status: "SKIPPED", reason: prepared.skipReason, payloadSchemaVersion: prepared.schemaVersion, nextAttemptAt: null } });
      return true;
    }
    const request = (delivery.frozenRequest ?? prepared.request) as LogicalRequest | undefined;
    if (!request) throw new Error("Delivery has no logical request");
    const digest = delivery.requestDigest ?? requestDigest(request);
    const token = randomUUID();
    const claimed = await prisma.$transaction(async (tx) => {
      const updated = await tx.conversionDelivery.updateMany({ where: { id: delivery.id, status: delivery.status, nextAttemptAt: delivery.nextAttemptAt }, data: { status: "PROCESSING", claimToken: token, leaseUntil: new Date(cycleTime.getTime() + config.deliveryLeaseMs), frozenRequest: request as unknown as Prisma.InputJsonObject, requestDigest: digest, payloadSchemaVersion: prepared.schemaVersion, reason: null } });
      if (!updated.count) return false;
      if (!savedContext) await tx.order.update({ where: { id: order.id }, data: { conversionContext: context as Prisma.InputJsonObject } });
      await tx.conversionAttempt.create({ data: { deliveryId: delivery.id, attemptNumber, startedAt: cycleTime, request: protectTransportData(request) as Prisma.InputJsonObject, requestDigest: digest } });
      return true;
    });
    if (!claimed) return true;
    let result: ProviderResult;
    try {
      result = await provider.send({ ...event, request });
    } catch {
      result = { outcome: "UNCERTAIN", httpStatus: null, response: null, errorCode: "TRANSPORT_UNKNOWN" };
    }
    await hooks.afterTransport?.();
    const finishTime = now();
    const exhausted = result.outcome === "TEMPORARY" && attemptNumber >= config.deliveryMaxAttempts;
    const status = result.outcome === "ACCEPTED" ? "DELIVERED" : result.outcome === "PERMANENT" ? "FAILED_PERMANENT" : result.outcome === "UNCERTAIN" ? "UNKNOWN" : exhausted ? "FAILED_EXHAUSTED" : "RETRY_PENDING";
    const attemptStatus = result.outcome === "ACCEPTED" ? "SUCCEEDED" : result.outcome === "PERMANENT" ? "FAILED_PERMANENT" : result.outcome === "UNCERTAIN" ? "UNKNOWN" : "FAILED_RETRYABLE";
    await prisma.$transaction(async (tx) => {
      const changed = await tx.conversionDelivery.updateMany({ where: { id: delivery.id, status: "PROCESSING", claimToken: token }, data: { status, reason: result.errorCode, claimToken: null, leaseUntil: null, nextAttemptAt: status === "RETRY_PENDING" ? new Date(finishTime.getTime() + retryDelay(result, attemptNumber, finishTime)) : null } });
      if (changed.count) await tx.conversionAttempt.update({ where: { deliveryId_attemptNumber: { deliveryId: delivery.id, attemptNumber } }, data: { status: attemptStatus, finishedAt: finishTime, httpStatus: result.httpStatus, errorCode: result.errorCode, response: result.response === null ? Prisma.JsonNull : protectTransportData(result.response) as Prisma.InputJsonObject } });
    });
    return true;
  }
  return { runOnce };
}
