import { WebSocketConnection } from "./ws-server.js";

type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: unknown;
};

type PendingCall<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type FileMetadata = {
  filename: string;
  atime: string;
  btime: string;
  mtime: string;
};

export type BitburnerFile = {
  filename: string;
  content: string;
};

export type SaveFile = {
  identifier: string;
  binary: boolean;
  save: string;
};

export type ServerInfo = {
  hostname: string;
  hasAdminRights: boolean;
  purchasedByPlayer: boolean;
};

export class BitburnerRemoteApi {
  private static readonly defaultTimeoutMs = 30_000;

  private nextId = 1;
  private pending = new Map<number, PendingCall<unknown>>();

  constructor(private connection: WebSocketConnection) {
    connection.onMessage((message) => this.handleMessage(message));
    connection.onClose(() => this.rejectAll("Bitburner disconnected"));
  }

  pushFile(filename: string, content: string, server = "home"): Promise<"OK"> {
    return this.call("pushFile", { filename, content, server });
  }

  getFile(filename: string, server = "home"): Promise<string> {
    return this.call("getFile", { filename, server });
  }

  getFileMetadata(filename: string, server = "home"): Promise<FileMetadata> {
    return this.call("getFileMetadata", { filename, server });
  }

  deleteFile(filename: string, server = "home"): Promise<"OK"> {
    return this.call("deleteFile", { filename, server });
  }

  getFileNames(server = "home"): Promise<string[]> {
    return this.call("getFileNames", { server });
  }

  getAllFiles(server = "home"): Promise<BitburnerFile[]> {
    return this.call("getAllFiles", { server });
  }

  getAllFileMetadata(server = "home"): Promise<FileMetadata[]> {
    return this.call("getAllFileMetadata", { server });
  }

  calculateRam(filename: string, server = "home"): Promise<number> {
    return this.call("calculateRam", { filename, server });
  }

  getDefinitionFile(): Promise<string> {
    return this.call("getDefinitionFile");
  }

  getSaveFile(): Promise<SaveFile> {
    return this.call("getSaveFile");
  }

  getAllServers(): Promise<ServerInfo[]> {
    return this.call("getAllServers");
  }

  private call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;

    const request = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params })
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }

        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Timed out waiting for ${method}`));
      }, BitburnerRemoteApi.defaultTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout
      });

      this.connection.sendText(JSON.stringify(request));
    });
  }

  private handleMessage(message: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    if (!isJsonRpcResponse(parsed)) {
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }

    this.pending.delete(parsed.id);
    clearTimeout(pending.timeout);

    if (parsed.error !== undefined && parsed.error !== null) {
      pending.reject(new Error(formatRpcError(parsed.error)));
      return;
    }

    pending.resolve(parsed.result);
  }

  private rejectAll(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }

    this.pending.clear();
  }
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const response = value as { jsonrpc?: unknown; id?: unknown };
  return response.jsonrpc === "2.0" && typeof response.id === "number" && Number.isFinite(response.id);
}

function formatRpcError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    try {
      const text = JSON.stringify(error);
      if (text !== undefined) {
        return text;
      }
    } catch {
      return String(error);
    }
  }

  return String(error);
}
