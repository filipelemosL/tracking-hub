import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { RequestHandler } from "express";

import { systemLog } from "../infra/logging/system-log.js";

function responseContent(body: unknown, contentType: unknown): unknown {
  if (typeof body === "string" && typeof contentType === "string" && contentType.includes("json")) {
    try { return JSON.parse(body) as unknown; } catch { return "[INVALID_JSON_RESPONSE]"; }
  }
  return body ?? null;
}

export const requestLogging: RequestHandler = (request, response, next) => {
  const requestId = randomUUID();
  const start = performance.now();
  let sentBody: unknown = null;
  const originalSend = response.send.bind(response);
  response.send = ((body?: unknown) => {
    sentBody = body;
    return originalSend(body);
  }) as typeof response.send;

  response.once("finish", () => {
    let path: string = "[INVALID_URL]";
    let query: Record<string, string[]> = {};
    try {
      const parsed = new URL(request.originalUrl, "http://tracking-hub.invalid");
      path = decodeURIComponent(parsed.pathname);
      query = Object.fromEntries([...new Set(parsed.searchParams.keys())].map((key) => [key, parsed.searchParams.getAll(key)]));
    } catch { /* keep the safe fallback */ }
    systemLog("http.request", {
      requestId, method: request.method, path, query, headers: request.headers,
      body: request.body ?? "[BODY_UNAVAILABLE]"
    });
    systemLog("http.response", {
      requestId, method: request.method, path, status: response.statusCode,
      durationMs: Math.round(performance.now() - start), headers: response.getHeaders(),
      body: responseContent(sentBody, response.getHeader("content-type"))
    });
  });
  next();
};
