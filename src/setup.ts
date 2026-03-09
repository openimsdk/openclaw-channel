/**
 * OpenIM TUI setup wizard
 * openclaw openim setup
 */

import {
  cancel as clackCancel,
  intro as clackIntro,
  isCancel,
  note as clackNote,
  outro as clackOutro,
  text as clackText,
} from "@clack/prompts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const OPENCLAW_HOME = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_HOME, "openclaw.json");

function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    clackCancel("Operation cancelled.");
    process.exit(0);
  }
  return value as T;
}

export async function runOpenIMSetup(): Promise<void> {
  clackIntro("OpenIM Channel Setup Wizard");

  const token = guardCancel(
    await clackText({
      message: "Enter OpenIM Access Token",
      initialValue: process.env.OPENIM_TOKEN || "",
    })
  );

  const wsAddr = guardCancel(
    await clackText({
      message: "Enter OpenIM WebSocket endpoint",
      initialValue: process.env.OPENIM_WS_ADDR || "ws://127.0.0.1:10001",
    })
  );

  const apiAddr = guardCancel(
    await clackText({
      message: "Enter OpenIM REST API endpoint",
      initialValue: process.env.OPENIM_API_ADDR || "http://127.0.0.1:10002",
    })
  );

  const trimmedToken = String(token).trim();
  const trimmedWsAddr = String(wsAddr).trim();
  const trimmedApiAddr = String(apiAddr).trim();

  if (!trimmedToken || !trimmedWsAddr || !trimmedApiAddr) {
    console.error("Configuration fields `token`, `wsAddr`, and `apiAddr` cannot be empty.");
    process.exit(1);
  }

  let existing: any = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
      existing = {};
    }
  }

  const channels = existing.channels || {};
  const openim = channels.openim || {};
  const accounts = openim.accounts || {};

  accounts.default = {
    enabled: true,
    token: trimmedToken,
    wsAddr: trimmedWsAddr,
    apiAddr: trimmedApiAddr,
  };

  channels.openim = {
    ...openim,
    enabled: true,
    accounts,
  };

  const next = { ...existing, channels };

  mkdirSync(OPENCLAW_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");

  clackNote(
    `Default account configuration written to: ${CONFIG_PATH}\nuserID/platformID are auto-derived from JWT token claims when omitted.`,
    "Setup complete"
  );
  clackOutro("Run `openclaw gateway restart` to load the updated configuration.");
}
