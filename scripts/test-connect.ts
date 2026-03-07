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

const userID = String(process.env.OPENIM_USER_ID ?? "").trim();
const token = String(process.env.OPENIM_TOKEN ?? "").trim();
const wsAddr = String(process.env.OPENIM_WS_ADDR ?? "").trim();
const apiAddr = String(process.env.OPENIM_API_ADDR ?? "").trim();
const platformID = parseInt(String(process.env.OPENIM_PLATFORM_ID ?? "5"), 10);

if (!userID || !token || !wsAddr || !apiAddr || !Number.isFinite(platformID)) {
  console.error("[OpenIM Test] Missing configuration. Set OPENIM_USER_ID / OPENIM_TOKEN / OPENIM_WS_ADDR / OPENIM_API_ADDR / OPENIM_PLATFORM_ID");
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
