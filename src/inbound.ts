import { SessionType, type MessageItem } from "@openim/client-sdk";
import { sendTextToTarget } from "./media";
import type { ChatType, InboundBodyResult, OpenIMClientState, ParsedTarget } from "./types";
import { formatSdkError } from "./utils";

const inboundDedup = new Map<string, number>();
const INBOUND_DEDUP_TTL_MS = 5 * 60 * 1000;

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

function isWhitelistedSender(client: OpenIMClientState, msg: MessageItem): boolean {
  const whitelist = client.config.inboundWhitelist;
  if (!Array.isArray(whitelist) || whitelist.length === 0) return true;
  const senderId = String(msg.sendID || "").trim();
  if (!senderId) return false;
  return whitelist.some((id) => id === senderId);
}

async function sendReplyFromInbound(client: OpenIMClientState, msg: MessageItem, text: string): Promise<void> {
  const isGroup = isGroupMessage(msg);
  const target: ParsedTarget = isGroup ? { kind: "group", id: String(msg.groupID) } : { kind: "user", id: String(msg.sendID) };
  await sendTextToTarget(client, target, text);
}

export async function processInboundMessage(api: any, client: OpenIMClientState, msg: MessageItem): Promise<void> {
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
  const mentioned = group && isMentionedInGroup(msg, client.config.userID);
  const hasWhitelist = client.config.inboundWhitelist.length > 0;
  if (hasWhitelist) {
    if (!isWhitelistedSender(client, msg)) return;
    if (group && !mentioned) return;
  } else if (group && client.config.requireMention && !mentioned) {
    return;
  }

  const baseSessionKey = group ? `openim:group:${msg.groupID}`.toLowerCase() : `openim:${msg.sendID}`.toLowerCase();
  const cfg = api.config;

  const route =
    runtime.channel.routing?.resolveAgentRoute?.({
      cfg,
      sessionKey: baseSessionKey,
      channel: "openim",
      accountId: client.config.accountId,
    }) ?? { agentId: "main", sessionKey: baseSessionKey };

  // Use router-resolved session key so history aligns with Control UI session namespaces.
  const sessionKey = String(route?.sessionKey ?? baseSessionKey).trim() || baseSessionKey;

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
    SessionKey: sessionKey,
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
      sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !group
        ? {
            sessionKey,
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
