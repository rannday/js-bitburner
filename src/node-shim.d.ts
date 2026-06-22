declare const Buffer: any;

declare module "node:http" {
  export function createServer(): any;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): any;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: string): Promise<string>;
}

declare const process: {
  exitCode?: number;
  argv: string[];
  stdout: {
    write(data: string): void;
  };
  stderr: {
    write(data: string): void;
  };
};
