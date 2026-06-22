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

declare module "node:readline/promises" {
  export function createInterface(options: {
    input: any;
    output: any;
  }): any;
}

declare const process: {
  exitCode?: number;
  argv: string[];
  stdin: any;
  stdout: {
    write(data: string): void;
  };
  stderr: {
    write(data: string): void;
  };
};
