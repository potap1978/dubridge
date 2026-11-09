export declare class Sandbox {
    readonly root: string;
    constructor(root: string);
    resolve(rel: string): string;
    read(p: string, offset?: number, limit?: number): Promise<string>;
    write(p: string, content: string): Promise<void>;
    edit(p: string, oldText: string, newText: string, replaceAll?: boolean): Promise<string>;
    list(p: string, depth?: number): Promise<string>;
    search(query: string, p?: string, opts?: {
        mode?: "content" | "filename";
        glob?: string;
        case_sensitive?: boolean;
        context?: number;
        max_results?: number;
    }): Promise<string>;
}
