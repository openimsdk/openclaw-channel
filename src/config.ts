import type { OpenIMAccountConfig } from "./types";
import { toFiniteNumber } from "./utils";

function getConfigRoot(apiOrCfg: any): any {
  if (apiOrCfg?.config) return apiOrCfg.config;
  if (apiOrCfg?.channels) return apiOrCfg;
  return (globalThis as any).__openimGatewayConfig ?? {};
}

export function getOpenIMChannelConfig(apiOrCfg: any): any {
  const root = getConfigRoot(apiOrCfg);
  return root?.channels?.openim ?? {};
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractAccountHintsFromToken(token: string): { userID?: string; platformID?: number } {
  const payload = decodeJwtPayload(token);
  if (!payload) return {};

  const userIDRaw = payload.UserID ?? payload.userID;
  const userID = String(userIDRaw ?? "").trim();

  const platformRaw = payload.PlatformID ?? payload.platformID;
  const platformID = toFiniteNumber(platformRaw, NaN);

  return {
    ...(userID ? { userID } : {}),
    ...(Number.isFinite(platformID) ? { platformID } : {}),
  };
}

function envDefaultAccount(): Record<string, unknown> | null {
  const token = String(process.env.OPENIM_TOKEN ?? "").trim();
  const wsAddr = String(process.env.OPENIM_WS_ADDR ?? "").trim();
  const apiAddr = String(process.env.OPENIM_API_ADDR ?? "").trim();
  if (!token || !wsAddr || !apiAddr) return null;

  const hints = extractAccountHintsFromToken(token);
  const userID = String(process.env.OPENIM_USER_ID ?? hints.userID ?? "").trim();
  const platformID = toFiniteNumber(process.env.OPENIM_PLATFORM_ID ?? hints.platformID, 5);
  if (!userID) return null;

  return {
    userID,
    token,
    wsAddr,
    apiAddr,
    platformID,
    enabled: true,
    requireMention: true,
  };
}

function normalizeInboundWhitelist(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const normalized = values.map((item) => String(item ?? "").trim()).filter(Boolean);
  return Array.from(new Set(normalized));
}

function normalizeAccount(accountId: string, raw: any): OpenIMAccountConfig | null {
  if (!raw || typeof raw !== "object") return null;

  const token = String(raw.token ?? "").trim();
  const wsAddr = String(raw.wsAddr ?? "").trim();
  const apiAddr = String(raw.apiAddr ?? "").trim();
  if (!token || !wsAddr || !apiAddr) return null;

  const hints = extractAccountHintsFromToken(token);
  const userID = String(raw.userID ?? hints.userID ?? "").trim();
  const platformID = toFiniteNumber(raw.platformID ?? hints.platformID, 5);
  const enabled = raw.enabled !== false;
  const requireMention = raw.requireMention !== false;
  const inboundWhitelist = normalizeInboundWhitelist(raw.inboundWhitelist);

  if (!userID) return null;

  return {
    accountId,
    enabled,
    userID,
    token,
    wsAddr,
    apiAddr,
    platformID,
    requireMention,
    inboundWhitelist,
  };
}

export function listAccountIds(apiOrCfg: any): string[] {
  const ch = getOpenIMChannelConfig(apiOrCfg);
  const accounts = ch?.accounts;

  if (accounts && typeof accounts === "object") {
    const ids = Object.keys(accounts);
    if (ids.length > 0) return ids;
  }

  if (ch?.userID || ch?.token || ch?.wsAddr || ch?.apiAddr) return ["default"];
  if (envDefaultAccount()) return ["default"];
  return [];
}

export function getOpenIMAccountConfig(apiOrCfg: any, accountId = "default"): OpenIMAccountConfig | null {
  const ch = getOpenIMChannelConfig(apiOrCfg);
  const accountRaw = ch?.accounts?.[accountId];
  if (accountRaw) {
    return normalizeAccount(accountId, accountRaw);
  }

  if (accountId === "default") {
    if (ch?.userID || ch?.token || ch?.wsAddr || ch?.apiAddr) {
      const normalized = normalizeAccount("default", ch);
      if (normalized) return normalized;
    }

    const env = envDefaultAccount();
    if (env) {
      return normalizeAccount("default", env);
    }
  }

  return null;
}

export function listEnabledAccountConfigs(apiOrCfg: any): OpenIMAccountConfig[] {
  const ids = listAccountIds(apiOrCfg);
  const out: OpenIMAccountConfig[] = [];

  for (const id of ids) {
    const cfg = getOpenIMAccountConfig(apiOrCfg, id);
    if (cfg && cfg.enabled) out.push(cfg);
  }

  return out;
}

export function resolveAccountConfig(apiOrCfg: any, accountId?: string): { accountId: string; [k: string]: unknown } {
  const id = accountId ?? "default";
  const ch = getOpenIMChannelConfig(apiOrCfg);

  if (ch?.accounts?.[id]) {
    return { accountId: id, ...ch.accounts[id] };
  }
  if (id === "default" && (ch?.userID || ch?.token || ch?.wsAddr || ch?.apiAddr)) {
    return { accountId: id, ...ch };
  }
  if (id === "default") {
    const env = envDefaultAccount();
    if (env) return { accountId: id, ...env };
  }
  return { accountId: id };
}
