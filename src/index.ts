/**
 * OpenClaw OpenIM Channel Plugin
 *
 * Integrates OpenIM into OpenClaw Gateway using @openim/client-sdk.
 * Supports multi-account concurrency, direct/group text messaging, and mention-gated group triggering.
 */

import {
  CbEvents,
  SessionType,
  getSDK,
  type ApiService,
  type CallbackEvent,
  type MessageItem,
} from "@openim/client-sdk";
import { File } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

type ChatType = "direct" | "group";

interface OpenIMAccountConfig {
  accountId: string;
  enabled: boolean;
  userID: string;
  token: string;
  wsAddr: string;
  apiAddr: string;
  platformID: number;
  requireMention: boolean;
}

interface OpenIMClientState {
  sdk: ApiService;
  config: OpenIMAccountConfig;
  handlers: {
    onRecvNewMessage: (event: CallbackEvent<MessageItem>) => void;
    onRecvNewMessages: (event: CallbackEvent<MessageItem[]>) => void;
    onRecvOfflineNewMessages: (event: CallbackEvent<MessageItem[]>) => void;
  };
}

interface ParsedTarget {
  kind: "user" | "group";
  id: string;
}

interface InboundBodyResult {
  body: string;
  kind: "text" | "image" | "video" | "file" | "mixed" | "unknown";
}

const clients = new Map<string, OpenIMClientState>();
const inboundDedup = new Map<string, number>();
const INBOUND_DEDUP_TTL_MS = 5 * 60 * 1000;

class NodeFileReaderPolyfill {
  public result: ArrayBuffer | null = null;
  public error: Error | null = null;
  public onload: ((ev: { target: NodeFileReaderPolyfill }) => void) | null = null;
  public onerror: ((err: unknown) => void) | null = null;

  readAsArrayBuffer(blob: Blob): void {
    void blob
      .arrayBuffer()
      .then((buffer) => {
        this.result = buffer;
        this.onload?.({ target: this });
      })
      .catch((err) => {
        this.error = err instanceof Error ? err : new Error(String(err));
        this.onerror?.(err);
      });
  }
}

if (typeof (globalThis as any).FileReader === "undefined") {
  (globalThis as any).FileReader = NodeFileReaderPolyfill;
}

function getConfigRoot(apiOrCfg: any): any {
  if (apiOrCfg?.config) return apiOrCfg.config;
  if (apiOrCfg?.channels) return apiOrCfg;
  return (globalThis as any).__openimGatewayConfig ?? {};
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatSdkError(error: unknown): string {
  const e = error as any;
  const fields: string[] = [];
  if (e?.event) fields.push(`event=${e.event}`);
  if (e?.errCode !== undefined) fields.push(`errCode=${e.errCode}`);
  if (e?.errMsg) fields.push(`errMsg=${e.errMsg}`);
  if (e?.operationID) fields.push(`operationID=${e.operationID}`);
  if (e?.data !== undefined && e?.data !== null) fields.push(`data=${safeStringify(e.data)}`);
  if (fields.length > 0) return fields.join(", ");
  if (e instanceof Error) return e.message;
  return safeStringify(error);
}

function getOpenIMChannelConfig(apiOrCfg: any): any {
  const root = getConfigRoot(apiOrCfg);
  return root?.channels?.openim ?? {};
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function envDefaultAccount(): Record<string, unknown> | null {
  const userID = String(process.env.OPENIM_USER_ID ?? "").trim();
  const token = String(process.env.OPENIM_TOKEN ?? "").trim();
  const wsAddr = String(process.env.OPENIM_WS_ADDR ?? "").trim();
  const apiAddr = String(process.env.OPENIM_API_ADDR ?? "").trim();
  const platformID = toFiniteNumber(process.env.OPENIM_PLATFORM_ID, 5);

  if (!userID || !token || !wsAddr || !apiAddr) return null;

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

function normalizeAccount(accountId: string, raw: any): OpenIMAccountConfig | null {
  if (!raw || typeof raw !== "object") return null;

  const userID = String(raw.userID ?? "").trim();
  const token = String(raw.token ?? "").trim();
  const wsAddr = String(raw.wsAddr ?? "").trim();
  const apiAddr = String(raw.apiAddr ?? "").trim();
  const platformID = toFiniteNumber(raw.platformID, 5);
  const enabled = raw.enabled !== false;
  const requireMention = raw.requireMention !== false;

  if (!userID || !token || !wsAddr || !apiAddr) return null;

  return {
    accountId,
    enabled,
    userID,
    token,
    wsAddr,
    apiAddr,
    platformID,
    requireMention,
  };
}

function listAccountIds(apiOrCfg: any): string[] {
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

function getOpenIMAccountConfig(apiOrCfg: any, accountId = "default"): OpenIMAccountConfig | null {
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

function listEnabledAccountConfigs(apiOrCfg: any): OpenIMAccountConfig[] {
  const ids = listAccountIds(apiOrCfg);
  const out: OpenIMAccountConfig[] = [];

  for (const id of ids) {
    const cfg = getOpenIMAccountConfig(apiOrCfg, id);
    if (cfg && cfg.enabled) out.push(cfg);
  }

  return out;
}

function parseTarget(to?: string): ParsedTarget | null {
  const raw = String(to ?? "").trim();
  if (!raw) return null;

  const t = raw.replace(/^openim:/i, "");
  if (t.startsWith("user:")) {
    const id = t.slice("user:".length).trim();
    return id ? { kind: "user", id } : null;
  }
  if (t.startsWith("group:")) {
    const id = t.slice("group:".length).trim();
    return id ? { kind: "group", id } : null;
  }

  return { kind: "user", id: t };
}

function getConnectedClient(accountId?: string): OpenIMClientState | null {
  if (accountId && clients.has(accountId)) {
    return clients.get(accountId) ?? null;
  }
  if (clients.has("default")) return clients.get("default") ?? null;

  const first = clients.values().next();
  return first.done ? null : first.value;
}

async function sendTextToTarget(client: OpenIMClientState, target: ParsedTarget, text: string): Promise<void> {
  const created = await client.sdk.createTextMessage(text);
  const message = created?.data;
  if (!message) throw new Error("createTextMessage failed");

  const recvID = target.kind === "user" ? target.id : "";
  const groupID = target.kind === "group" ? target.id : "";

  await client.sdk.sendMessage({
    recvID,
    groupID,
    message,
  });
}

function getRecvAndGroupID(target: ParsedTarget): { recvID: string; groupID: string } {
  return {
    recvID: target.kind === "user" ? target.id : "",
    groupID: target.kind === "group" ? target.id : "",
  };
}

function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

function toLocalPath(input: string): string {
  const raw = input.trim();
  if (raw.startsWith("file://")) return decodeURIComponent(raw.slice("file://".length));
  return raw;
}

function guessMime(pathOrName: string, fallback = "application/octet-stream"): string {
  const ext = extname(pathOrName).toLowerCase();
  const table: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".json": "application/json",
    ".zip": "application/zip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return table[ext] || fallback;
}

function inferNameFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const name = basename(u.pathname || "");
    return name || fallback;
  } catch {
    return fallback;
  }
}

async function readLocalAsFile(pathInput: string, forcedName?: string): Promise<{
  file: File;
  filePath: string;
  fileName: string;
  size: number;
  mime: string;
}> {
  const filePath = toLocalPath(pathInput);
  const st = await stat(filePath);
  const data = await readFile(filePath);
  const fileName = forcedName?.trim() || basename(filePath) || `file-${Date.now()}`;
  const mime = guessMime(fileName);
  const file = new File([data], fileName, { type: mime });
  return { file, filePath, fileName, size: st.size, mime };
}

async function sendImageToTarget(client: OpenIMClientState, target: ParsedTarget, image: string): Promise<void> {
  const input = image.trim();
  if (!input) throw new Error("image is empty");

  let message: MessageItem | undefined;
  if (isUrl(input)) {
    const name = inferNameFromUrl(input, "image.jpg");
    const pic = {
      uuid: randomUUID(),
      type: guessMime(name, "image/jpeg"),
      size: 0,
      width: 0,
      height: 0,
      url: input,
    };
    const created = await client.sdk.createImageMessageByURL({
      sourcePicture: pic,
      bigPicture: { ...pic },
      snapshotPicture: { ...pic },
      sourcePath: name,
    });
    message = created?.data;
  } else {
    const local = await readLocalAsFile(input);
    const pic = {
      uuid: randomUUID(),
      type: local.mime,
      size: local.size,
      width: 0,
      height: 0,
      url: "",
    };
    const created = await client.sdk.createImageMessageByFile({
      sourcePicture: pic,
      bigPicture: { ...pic },
      snapshotPicture: { ...pic },
      sourcePath: local.filePath,
      file: local.file,
    });
    message = created?.data;
  }

  if (!message) throw new Error("createImageMessage failed");
  const { recvID, groupID } = getRecvAndGroupID(target);
  await client.sdk.sendMessage({ recvID, groupID, message });
}

async function sendVideoToTarget(
  client: OpenIMClientState,
  target: ParsedTarget,
  video: string,
  name?: string
): Promise<void> {
  const input = video.trim();
  if (!input) throw new Error("video is empty");
  // Product policy: do not send OpenIM video messages; send videos as file messages.
  await sendFileToTarget(client, target, input, name);
}

async function sendFileToTarget(
  client: OpenIMClientState,
  target: ParsedTarget,
  filePathOrUrl: string,
  name?: string
): Promise<void> {
  const input = filePathOrUrl.trim();
  if (!input) throw new Error("file is empty");

  let message: MessageItem | undefined;
  if (isUrl(input)) {
    const fileName = name?.trim() || inferNameFromUrl(input, "file.bin");
    const created = await client.sdk.createFileMessageByURL({
      filePath: fileName,
      fileName,
      uuid: randomUUID(),
      sourceUrl: input,
      fileSize: 0,
      fileType: guessMime(fileName),
    });
    message = created?.data;
  } else {
    const local = await readLocalAsFile(input, name);
    const created = await client.sdk.createFileMessageByFile({
      filePath: local.filePath,
      fileName: local.fileName,
      uuid: randomUUID(),
      sourceUrl: "",
      fileSize: local.size,
      fileType: local.mime,
      file: local.file,
    });
    message = created?.data;
  }

  if (!message) throw new Error("createFileMessage failed");
  const { recvID, groupID } = getRecvAndGroupID(target);
  await client.sdk.sendMessage({ recvID, groupID, message });
}

function extractInboundBody(msg: MessageItem, depth = 0): InboundBodyResult {
  if (msg.quoteElem?.quoteMessage) {
    const quotedMsg = msg.quoteElem.quoteMessage;
    const quotedSender = String(quotedMsg.senderNickname || quotedMsg.sendID || "unknown");
    const quotedBody = depth < 2 ? extractInboundBody(quotedMsg, depth + 1).body || "[empty message]" : "[quoted message]";
    const current = String(msg.quoteElem.text ?? msg.textElem?.content ?? msg.atTextElem?.text ?? "").trim();

    if (current) {
      return {
        body: `[Quote] ${quotedSender}: ${quotedBody}\nReply: ${current}`,
        kind: "mixed",
      };
    }
    return {
      body: `[Quote] ${quotedSender}: ${quotedBody}`,
      kind: "mixed",
    };
  }

  const text = String(msg.textElem?.content ?? msg.atTextElem?.text ?? "").trim();
  if (text) return { body: text, kind: "text" };

  const pic = msg.pictureElem;
  if (pic) {
    const imageUrl = pic.sourcePicture?.url || pic.bigPicture?.url || pic.snapshotPicture?.url || "";
    const imageBody = imageUrl ? `[Image] ${imageUrl}` : "[Image message]";
    return { body: imageBody, kind: "image" };
  }

  const video = msg.videoElem;
  if (video) {
    const url = video.videoUrl || "";
    const snapshotUrl = video.snapshotUrl || "";
    const parts = ["[Video]"];
    if (url) parts.push(`video=${url}`);
    if (snapshotUrl) parts.push(`snapshot=${snapshotUrl}`);
    return { body: parts.join(" "), kind: "video" };
  }

  const file = msg.fileElem;
  if (file) {
    const parts = ["[File]"];
    if (file.fileName) parts.push(`name=${file.fileName}`);
    if (file.sourceUrl) parts.push(`url=${file.sourceUrl}`);
    if (file.fileSize) parts.push(`size=${file.fileSize}`);
    return { body: parts.join(" "), kind: "file" };
  }

  if (msg.customElem?.data || msg.customElem?.description || msg.customElem?.extension) {
    const customText = msg.customElem.description || msg.customElem.data || msg.customElem.extension || "[Custom message]";
    return { body: `[Custom message] ${customText}`, kind: "mixed" };
  }

  return { body: "", kind: "unknown" };
}

function shouldProcessInboundMessage(accountId: string, msg: MessageItem): boolean {
  const idPart = String(msg.clientMsgID || msg.serverMsgID || `${msg.sendID}-${msg.seq || msg.createTime || 0}`);
  if (!idPart) return true;

  const key = `${accountId}:${idPart}`;
  const now = Date.now();
  const last = inboundDedup.get(key);
  inboundDedup.set(key, now);

  if (inboundDedup.size > 2000) {
    for (const [k, ts] of inboundDedup.entries()) {
      if (now - ts > INBOUND_DEDUP_TTL_MS) inboundDedup.delete(k);
    }
  }

  return !(last && now - last < INBOUND_DEDUP_TTL_MS);
}

function isGroupMessage(msg: MessageItem): boolean {
  return msg.sessionType === SessionType.Group && !!msg.groupID;
}

function isMentionedInGroup(msg: MessageItem, selfUserID: string): boolean {
  const list = msg.atTextElem?.atUserList;
  if (!Array.isArray(list) || list.length === 0) return false;
  const id = String(selfUserID);
  return list.some((item) => String(item) === id);
}

async function sendReplyFromInbound(client: OpenIMClientState, msg: MessageItem, text: string): Promise<void> {
  const isGroup = isGroupMessage(msg);
  const target: ParsedTarget = isGroup ? { kind: "group", id: String(msg.groupID) } : { kind: "user", id: String(msg.sendID) };
  await sendTextToTarget(client, target, text);
}

async function processInboundMessage(api: any, client: OpenIMClientState, msg: MessageItem): Promise<void> {
  const runtime = api.runtime;
  if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    api.logger?.warn?.("[openim] runtime.channel.reply not available");
    return;
  }

  if (String(msg.sendID) === String(client.config.userID)) {
    return;
  }
  if (!shouldProcessInboundMessage(client.config.accountId, msg)) {
    return;
  }

  const inbound = extractInboundBody(msg);
  if (!inbound.body) {
    api.logger?.info?.(
      `[openim] ignore unsupported message: contentType=${msg.contentType}, clientMsgID=${msg.clientMsgID || "unknown"}`
    );
    return;
  }

  const group = isGroupMessage(msg);
  if (group && client.config.requireMention && !isMentionedInGroup(msg, client.config.userID)) {
    return;
  }

  const sessionId = group ? `openim:group:${msg.groupID}`.toLowerCase() : `openim:${msg.sendID}`.toLowerCase();
  const cfg = api.config;

  const route =
    runtime.channel.routing?.resolveAgentRoute?.({
      cfg,
      sessionKey: sessionId,
      channel: "openim",
      accountId: client.config.accountId,
    }) ?? { agentId: "main" };

  const storePath =
    runtime.channel.session?.resolveStorePath?.(cfg?.session?.store, {
      agentId: route.agentId,
    }) ?? "";

  const chatType: ChatType = group ? "group" : "direct";
  const fromLabel = String(msg.senderNickname || msg.sendID);
  const envelopeOptions = runtime.channel.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};

  const body =
    runtime.channel.reply?.formatInboundEnvelope?.({
      channel: "OpenIM",
      from: fromLabel,
      timestamp: msg.sendTime || Date.now(),
      body: inbound.body,
      chatType,
      sender: { name: fromLabel, id: String(msg.sendID) },
      envelope: envelopeOptions,
    }) ?? { content: [{ type: "text", text: inbound.body }] };

  const ctxPayload = {
    Body: body,
    RawBody: inbound.body,
    From: group ? `openim:group:${msg.groupID}` : `openim:${msg.sendID}`,
    To: `openim:${client.config.userID}`,
    SessionKey: sessionId,
    AccountId: client.config.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: fromLabel,
    SenderId: String(msg.sendID),
    Provider: "openim",
    Surface: "openim",
    MessageSid: msg.clientMsgID || `openim-${Date.now()}`,
    Timestamp: msg.sendTime || Date.now(),
    OriginatingChannel: "openim",
    OriginatingTo: `openim:${client.config.userID}`,
    CommandAuthorized: true,
    _openim: {
      accountId: client.config.accountId,
      isGroup: group,
      senderId: String(msg.sendID),
      groupId: String(msg.groupID || ""),
      messageKind: inbound.kind,
    },
  };

  if (runtime.channel.session?.recordInboundSession) {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: !group
        ? {
            sessionKey: sessionId,
            channel: "openim",
            to: String(msg.sendID),
            accountId: client.config.accountId,
          }
        : undefined,
      onRecordError: (err: unknown) => api.logger?.warn?.(`[openim] recordInboundSession: ${String(err)}`),
    });
  }

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({
      channel: "openim",
      accountId: client.config.accountId,
      direction: "inbound",
    });
  }

  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string }) => {
          if (!payload.text) return;
          try {
            await sendReplyFromInbound(client, msg, payload.text);
          } catch (e: any) {
            api.logger?.error?.(`[openim] deliver failed: ${formatSdkError(e)}`);
          }
        },
        onError: (err: unknown, info: { kind?: string }) => {
          api.logger?.error?.(`[openim] ${info?.kind || "reply"} failed: ${String(err)}`);
        },
      },
      replyOptions: { disableBlockStreaming: true },
    });
  } catch (err: any) {
    api.logger?.error?.(`[openim] dispatch failed: ${formatSdkError(err)}`);
    try {
      const errMsg = formatSdkError(err);
      await sendReplyFromInbound(client, msg, `Processing failed: ${errMsg.slice(0, 80)}`);
    } catch {
      // ignore secondary send errors
    }
  }
}

function detachHandlers(state: OpenIMClientState): void {
  state.sdk.off(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
  state.sdk.off(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
  state.sdk.off(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);
}

async function startAccountClient(api: any, config: OpenIMAccountConfig): Promise<void> {
  const sdk = getSDK();

  const state = {
    sdk,
    config,
    handlers: {
      onRecvNewMessage: () => undefined,
      onRecvNewMessages: () => undefined,
      onRecvOfflineNewMessages: () => undefined,
    },
  } as OpenIMClientState;

  const consumeMessage = (msg: MessageItem) => {
    processInboundMessage(api, state, msg).catch((e: any) => {
      api.logger?.error?.(`[openim] processInboundMessage failed: ${formatSdkError(e)}`);
    });
  };

  state.handlers.onRecvNewMessage = (event: CallbackEvent<MessageItem>) => {
    if (event?.data) consumeMessage(event.data);
  };
  state.handlers.onRecvNewMessages = (event: CallbackEvent<MessageItem[]>) => {
    const list = Array.isArray(event?.data) ? event.data : [];
    for (const msg of list) consumeMessage(msg);
  };
  state.handlers.onRecvOfflineNewMessages = (event: CallbackEvent<MessageItem[]>) => {
    const list = Array.isArray(event?.data) ? event.data : [];
    for (const msg of list) consumeMessage(msg);
  };

  sdk.on(CbEvents.OnRecvNewMessage, state.handlers.onRecvNewMessage);
  sdk.on(CbEvents.OnRecvNewMessages, state.handlers.onRecvNewMessages);
  sdk.on(CbEvents.OnRecvOfflineNewMessages, state.handlers.onRecvOfflineNewMessages);

  try {
    await sdk.login({
      userID: config.userID,
      token: config.token,
      wsAddr: config.wsAddr,
      apiAddr: config.apiAddr,
      platformID: config.platformID,
    });
    clients.set(config.accountId, state);
    api.logger?.info?.(`[openim] account ${config.accountId} connected`);
  } catch (e: any) {
    detachHandlers(state);
    api.logger?.error?.(`[openim] account ${config.accountId} login failed: ${formatSdkError(e)}`);
  }
}

async function stopAllClients(api: any): Promise<void> {
  const items = Array.from(clients.values());
  clients.clear();

  for (const state of items) {
    detachHandlers(state);
    try {
      await state.sdk.logout();
    } catch (e: any) {
      api.logger?.warn?.(`[openim] account ${state.config.accountId} logout failed: ${formatSdkError(e)}`);
    }
  }
}

const OpenIMChannelPlugin = {
  id: "openim",
  meta: {
    id: "openim",
    label: "OpenIM",
    selectionLabel: "OpenIM",
    docsPath: "/channels/openim",
    blurb: "OpenIM protocol channel via @openim/client-sdk",
    aliases: ["openim", "im"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
  },
  config: {
    listAccountIds: (cfg: any) => listAccountIds(cfg),
    resolveAccount: (cfg: any, accountId?: string) => {
      const id = accountId ?? "default";
      const ch = getOpenIMChannelConfig(cfg);

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
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    resolveTarget: ({ to }: { to?: string }) => {
      const target = parseTarget(to);
      if (!target) {
        return { ok: false, error: new Error("OpenIM requires --to <user:ID|group:ID>") };
      }
      return { ok: true, to: `${target.kind}:${target.id}` };
    },
    sendText: async ({ to, text, accountId }: { to: string; text: string; accountId?: string }) => {
      const target = parseTarget(to);
      if (!target) {
        return { ok: false, error: new Error("invalid target, expected user:<id> or group:<id>") };
      }
      const client = getConnectedClient(accountId);
      if (!client) {
        return { ok: false, error: new Error("OpenIM not connected") };
      }
      try {
        await sendTextToTarget(client, target, text);
        return { ok: true, provider: "openim" };
      } catch (e: any) {
        return { ok: false, error: new Error(formatSdkError(e)) };
      }
    },
  },
};

export default function register(api: any): void {
  (globalThis as any).__openimApi = api;
  (globalThis as any).__openimGatewayConfig = api.config;

  api.registerChannel({ plugin: OpenIMChannelPlugin });

  if (typeof api.registerCli === "function") {
    api.registerCli(
      (ctx: any) => {
        const prog = ctx.program;
        if (prog && typeof prog.command === "function") {
          const openim = prog.command("openim").description("OpenIM channel configuration");
          openim.command("setup").description("Interactive setup for the OpenIM default account").action(async () => {
            const { runOpenIMSetup } = await import("./setup");
            await runOpenIMSetup();
          });
        }
      },
      { commands: ["openim"] }
    );
  }

  if (typeof api.registerTool === "function") {
    const ensureTargetAndClient = (params: { target?: string; accountId?: string }) => {
      const target = parseTarget(params.target);
      if (!target) {
        return {
          ok: false as const,
          result: {
            content: [{ type: "text", text: "Invalid target format. Expected user:<id> or group:<id>." }],
          },
        };
      }
      const client = getConnectedClient(params.accountId);
      if (!client) {
        return {
          ok: false as const,
          result: {
            content: [{ type: "text", text: "OpenIM is not connected." }],
          },
        };
      }
      return { ok: true as const, target, client };
    };

    api.registerTool({
      name: "openim_send_text",
      description: "Send a text message via OpenIM. target format: user:ID or group:ID.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "user:123 or group:456" },
          text: { type: "string", description: "Text to send" },
          accountId: { type: "string", description: "Optional account ID. Defaults to `default` or the first connected account." },
        },
        required: ["target", "text"],
      },
      async execute(_id: string, params: { target: string; text: string; accountId?: string }) {
        const checked = ensureTargetAndClient(params);
        if (!checked.ok) return checked.result;
        try {
          await sendTextToTarget(checked.client, checked.target, params.text);
          return { content: [{ type: "text", text: "Sent successfully" }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
        }
      },
    });

    api.registerTool({
      name: "openim_send_image",
      description: "Send an image via OpenIM. `image` supports a local path or an http(s) URL.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "user:123 or group:456" },
          image: { type: "string", description: "Local path (`file://` supported) or URL" },
          accountId: { type: "string", description: "Optional account ID" },
        },
        required: ["target", "image"],
      },
      async execute(_id: string, params: { target: string; image: string; accountId?: string }) {
        const checked = ensureTargetAndClient(params);
        if (!checked.ok) return checked.result;
        try {
          await sendImageToTarget(checked.client, checked.target, params.image);
          return { content: [{ type: "text", text: "Image sent successfully" }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
        }
      },
    });

    api.registerTool({
      name: "openim_send_video",
      description: "Send a video via OpenIM (delivered as a file message). `video` supports a local path or URL.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "user:123 or group:456" },
          video: { type: "string", description: "Local path (`file://` supported) or URL" },
          name: { type: "string", description: "Optional filename (recommended for URL input)" },
          accountId: { type: "string", description: "Optional account ID" },
        },
        required: ["target", "video"],
      },
      async execute(_id: string, params: { target: string; video: string; name?: string; accountId?: string }) {
        const checked = ensureTargetAndClient(params);
        if (!checked.ok) return checked.result;
        try {
          await sendVideoToTarget(checked.client, checked.target, params.video, params.name);
          return { content: [{ type: "text", text: "Video sent successfully as a file" }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
        }
      },
    });

    api.registerTool({
      name: "openim_send_file",
      description: "Send a file via OpenIM. `file` supports a local path or URL; `name` is optional.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "user:123 or group:456" },
          file: { type: "string", description: "Local path (`file://` supported) or URL" },
          name: { type: "string", description: "Optional filename (recommended for URL input)" },
          accountId: { type: "string", description: "Optional account ID" },
        },
        required: ["target", "file"],
      },
      async execute(_id: string, params: { target: string; file: string; name?: string; accountId?: string }) {
        const checked = ensureTargetAndClient(params);
        if (!checked.ok) return checked.result;
        try {
          await sendFileToTarget(checked.client, checked.target, params.file, params.name);
          return { content: [{ type: "text", text: "File sent successfully" }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
        }
      },
    });
  }

  api.registerService({
    id: "openim-sdk",
    start: async () => {
      if (clients.size > 0) {
        api.logger?.info?.("[openim] service already started");
        return;
      }

      const accounts = listEnabledAccountConfigs(api);
      if (accounts.length === 0) {
        api.logger?.warn?.("[openim] no enabled account config found");
        return;
      }

      for (const account of accounts) {
        await startAccountClient(api, account);
      }

      api.logger?.info?.(`[openim] service started with ${clients.size}/${accounts.length} connected accounts`);
    },
    stop: async () => {
      await stopAllClients(api);
      api.logger?.info?.("[openim] service stopped");
    },
  });

  api.logger?.info?.("[openim] plugin loaded");
}
