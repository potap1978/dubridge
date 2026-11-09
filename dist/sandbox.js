import path from "node:path";
import fs from "node:fs/promises";
export class Sandbox {
    root;
    constructor(root) {
        this.root = root;
    }
    resolve(rel) {
        const abs = path.isAbsolute(rel) ? rel : path.resolve(this.root, rel);
        const norm = path.resolve(abs);
        const root = path.resolve(this.root);
        const relToRoot = path.relative(root, norm);
        if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
            throw new Error(`OUT_OF_SANDBOX: ${rel}`);
        }
        return norm;
    }
    async read(p, offset = 1, limit = 2000) {
        const abs = this.resolve(p);
        const buf = await fs.readFile(abs);
        if (buf.includes(0))
            throw new Error(`BINARY_FILE: ${p}`);
        const lines = buf.toString("utf8").split(/\r?\n/);
        return lines.slice(Math.max(0, offset - 1), offset - 1 + limit).join("\n");
    }
    async write(p, content) {
        const abs = this.resolve(p);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
        const check = await fs.readFile(abs, "utf8");
        if (check !== content)
            throw new Error(`WRITE_VERIFY_FAILED: ${p}`);
    }
    async edit(p, oldText, newText, replaceAll = false) {
        const abs = this.resolve(p);
        const text = await fs.readFile(abs, "utf8");
        if (oldText === newText)
            throw new Error(`NO_CHANGE: ${p}`);
        const idx = text.indexOf(oldText);
        if (idx < 0)
            throw new Error(`NOT_FOUND: ${p}`);
        if (!replaceAll && text.indexOf(oldText, idx + 1) >= 0) {
            throw new Error(`MULTI_MATCH: ${p} (use replace_all)`);
        }
        const updated = replaceAll ? text.split(oldText).join(newText) : text.slice(0, idx) + newText + text.slice(idx + oldText.length);
        await fs.writeFile(abs, updated, "utf8");
        const firstLine = text.slice(0, idx).split(/\r?\n/).length;
        return `first changed line: ${firstLine}`;
    }
    async list(p, depth = 1) {
        const abs = this.resolve(p);
        const skip = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".cache", "target", "vendor", "__pycache__", ".venv", "venv", ".idea", ".vscode"]);
        const out = [];
        const walk = async (cur, d, prefix) => {
            if (d > depth)
                return;
            const entries = await fs.readdir(cur, { withFileTypes: true });
            for (const e of entries) {
                if (e.isDirectory() && skip.has(e.name))
                    continue;
                out.push(prefix + e.name + (e.isDirectory() ? "/" : ""));
                if (e.isDirectory() && d < depth)
                    await walk(path.join(cur, e.name), d + 1, prefix + "  ");
            }
        };
        await walk(abs, 1, "");
        return out.slice(0, 800).join("\n");
    }
    async search(query, p = ".", opts = {}) {
        const root = this.resolve(p);
        const mode = opts.mode ?? "content";
        const re = new RegExp(escapeRegex(query), opts.case_sensitive ? "" : "i");
        const ctx = opts.context ?? 0;
        const max = opts.max_results ?? 60;
        const results = [];
        const globRe = opts.glob ? globToRegex(opts.glob) : null;
        const walk = async (cur) => {
            const entries = await fs.readdir(cur, { withFileTypes: true });
            for (const e of entries) {
                if (results.length >= max)
                    return;
                if (e.name === "node_modules" || e.name === ".git")
                    continue;
                const full = path.join(cur, e.name);
                if (e.isDirectory()) {
                    await walk(full);
                    continue;
                }
                if (globRe && !globRe.test(e.name))
                    continue;
                if (mode === "filename") {
                    if (re.test(e.name))
                        results.push(full);
                    continue;
                }
                let buf;
                try {
                    buf = await fs.readFile(full);
                }
                catch {
                    continue;
                }
                if (buf.includes(0))
                    continue;
                const lines = buf.toString("utf8").split(/\r?\n/);
                for (let i = 0; i < lines.length && results.length < max; i++) {
                    if (re.test(lines[i])) {
                        const from = Math.max(0, i - ctx);
                        const to = Math.min(lines.length, i + ctx + 1);
                        for (let j = from; j < to; j++) {
                            const tag = j === i ? ":" : "-";
                            results.push(`${full}${tag}${j + 1}${tag} ${lines[j]}`);
                        }
                    }
                }
            }
        };
        await walk(root);
        return results.slice(0, max).join("\n") || "(no matches)";
    }
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function globToRegex(g) {
    const pat = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*").replace(/\?/g, ".");
    return new RegExp("^" + pat + "$");
}
//# sourceMappingURL=sandbox.js.map