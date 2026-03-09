/**
 * OpenIM connection test script
 * Loads OPENIM_* values from .env first, logs in, prints status, and exits.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { CbEvents, getSDK } from "@openim/client-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv(): void {
  const candidates = [resolve(__dirname, "../.env"), resolve(__dirname, "../../.env")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (!match) continue;
      const key = match[1].trim();
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
    return;
  }
}

loadEnv();

const token = String(process.env.OPENIM_TOKEN ?? "").trim();
const wsAddr = String(process.env.OPENIM_WS_ADDR ?? "").trim();
const apiAddr = String(process.env.OPENIM_API_ADDR ?? "").trim();
if (!token || !wsAddr || !apiAddr) {
  console.error("[OpenIM Test] Missing configuration. Set OPENIM_TOKEN / OPENIM_WS_ADDR / OPENIM_API_ADDR");
  process.exit(1);
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function decodeJwtPayload(input: string): Record<string, unknown> | null {
  const parts = input.split(".");
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

function extractHintsFromToken(input: string): { userID?: string; platformID?: number } {
  const payload = decodeJwtPayload(input);
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

const hints = extractHintsFromToken(token);
const userID = String(process.env.OPENIM_USER_ID ?? hints.userID ?? "").trim();
const platformID = toFiniteNumber(process.env.OPENIM_PLATFORM_ID ?? hints.platformID, 5);

if (!userID) {
  console.error("[OpenIM Test] Cannot resolve userID. Provide OPENIM_USER_ID or use a JWT token with UserID claim.");
  process.exit(1);
}

async function main(): Promise<void> {
  const sdk = getSDK();

  sdk.on(CbEvents.OnConnecting, () => console.log("[OpenIM Test] Connecting..."));
  sdk.on(CbEvents.OnConnectSuccess, () => console.log("[OpenIM Test] Connected"));
  sdk.on(CbEvents.OnConnectFailed, (evt: any) => {
    console.error("[OpenIM Test] Connect failed:", evt?.errCode, evt?.errMsg);
  });

  try {
    await sdk.login({
      userID,
      token,
      wsAddr,
      apiAddr,
      platformID,
    });

    const status = await sdk.getLoginStatus();
    console.log("[OpenIM Test] Login status:", status?.data);

    const self = await sdk.getSelfUserInfo();
    console.log("[OpenIM Test] Self user:", self?.data?.userID, self?.data?.nickname || "");

    console.log("[OpenIM Test] SUCCESS");
  } catch (e: any) {
    console.error("[OpenIM Test] FAILED:", e?.message || String(e));
    process.exitCode = 1;
  } finally {
    try {
      await sdk.logout();
    } catch {
      // ignore
    }
  }
}

main();
