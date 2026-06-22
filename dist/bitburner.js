export class BitburnerRemoteApi {
    connection;
    nextId = 1;
    pending = new Map();
    constructor(connection) {
        this.connection = connection;
        connection.onMessage((message) => this.handleMessage(message));
        connection.onClose(() => this.rejectAll("Bitburner disconnected"));
    }
    pushFile(filename, content, server = "home") {
        return this.call("pushFile", { filename, content, server });
    }
    getFile(filename, server = "home") {
        return this.call("getFile", { filename, server });
    }
    getFileMetadata(filename, server = "home") {
        return this.call("getFileMetadata", { filename, server });
    }
    deleteFile(filename, server = "home") {
        return this.call("deleteFile", { filename, server });
    }
    getFileNames(server = "home") {
        return this.call("getFileNames", { server });
    }
    getAllFiles(server = "home") {
        return this.call("getAllFiles", { server });
    }
    getAllFileMetadata(server = "home") {
        return this.call("getAllFileMetadata", { server });
    }
    calculateRam(filename, server = "home") {
        return this.call("calculateRam", { filename, server });
    }
    getDefinitionFile() {
        return this.call("getDefinitionFile");
    }
    getSaveFile() {
        return this.call("getSaveFile");
    }
    getAllServers() {
        return this.call("getAllServers");
    }
    call(method, params) {
        const id = this.nextId++;
        const request = {
            jsonrpc: "2.0",
            id,
            method,
            ...(params === undefined ? {} : { params })
        };
        return new Promise((resolve, reject) => {
            this.pending.set(id, {
                resolve: resolve,
                reject
            });
            this.connection.sendText(JSON.stringify(request));
        });
    }
    handleMessage(message) {
        let response;
        try {
            response = JSON.parse(message);
        }
        catch {
            return;
        }
        const pending = this.pending.get(response.id);
        if (!pending)
            return;
        this.pending.delete(response.id);
        if (response.error !== undefined && response.error !== null) {
            pending.reject(new Error(JSON.stringify(response.error)));
            return;
        }
        pending.resolve(response.result);
    }
    rejectAll(reason) {
        for (const pending of this.pending.values()) {
            pending.reject(new Error(reason));
        }
        this.pending.clear();
    }
}
