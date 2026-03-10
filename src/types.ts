import type { ApiService, CallbackEvent, MessageItem } from "@openim/client-sdk";

export type ChatType = "direct" | "group";

export interface OpenIMAccountConfig {
  accountId: string;
  enabled: boolean;
  userID: string;
  token: string;
  wsAddr: string;
  apiAddr: string;
  platformID: number;
  requireMention: boolean;
  inboundWhitelist: string[];
}

export interface OpenIMClientState {
  sdk: ApiService;
  config: OpenIMAccountConfig;
  handlers: {
    onRecvNewMessage: (event: CallbackEvent<MessageItem>) => void;
    onRecvNewMessages: (event: CallbackEvent<MessageItem[]>) => void;
    onRecvOfflineNewMessages: (event: CallbackEvent<MessageItem[]>) => void;
  };
}

export interface ParsedTarget {
  kind: "user" | "group";
  id: string;
}

export interface InboundBodyResult {
  body: string;
  kind: "text" | "image" | "video" | "file" | "mixed" | "unknown";
}
