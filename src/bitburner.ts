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
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject
      });

      this.connection.sendText(JSON.stringify(request));
    });
  }

  private handleMessage(message: string): void {
    let response: JsonRpcResponse<unknown>;

    try {
      response = JSON.parse(message);
    } catch {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);

    if (response.error !== undefined && response.error !== null) {
      pending.reject(new Error(JSON.stringify(response.error)));
      return;
    }

    pending.resolve(response.result);
  }

  private rejectAll(reason: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(reason));
    }

    this.pending.clear();
  }
}
