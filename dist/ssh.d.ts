interface AuthConfig {
    type: "key" | "password";
    key?: string;
    passphrase?: string;
    password?: string;
    password_env?: string;
}
export declare function sshProbe(host: string, port?: number, auth?: AuthConfig): Promise<string>;
export declare function sshExec(host: string, command: string, cwd?: string, port?: number, auth?: AuthConfig, timeout?: number): Promise<string>;
export declare function sshCopy(host: string, direction: "up" | "down", src: string, dst: string, port?: number, auth?: AuthConfig, overwrite?: boolean, timeout?: number): Promise<string>;
export {};
