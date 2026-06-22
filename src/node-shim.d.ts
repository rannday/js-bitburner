declare const Buffer: any;

declare module "node:http" {
  export function createServer(): any;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): any;
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
