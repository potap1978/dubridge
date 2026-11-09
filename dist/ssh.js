import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
let SSH2_MODULE = null;
async function loadSsh2() {
    if (SSH2_MODULE)
        return SSH2_MODULE;
    try {
        SSH2_MODULE = await import("ssh2");
        return SSH2_MODULE;
    }
    catch (e) {
        throw new Error("TOOL_DISABLED: ssh2 module not available (native build failed during npm install). " +
            "SSH features are disabled. Reinstall with Visual Studio Build Tools, or use local tools only.");
    }
}
async function getConnection(host, port = 22, auth = { type: "key" }) {
    let user = "";
    let hostname = host;
    if (host.includes("@")) {
        [user, hostname] = host.split("@");
    }
    const config = {
        host: hostname,
        port: port || 22,
        username: user || undefined,
        readyTimeout: 20000,
        strictVendor: false,
        hostVerifier: () => true, // Упрощенная проверка (в реальном проекте нужно читать known_hosts)
    };
    if (auth.type === "password") {
        config.password = auth.password;
        if (auth.password_env) {
            config.password = process.env[auth.password_env];
        }
        if (!config.password)
            throw new Error("SSH_PASS_REQUIRED: password or password_env not set");
    }
    else {
        let keyPath = auth.key;
        if (!keyPath) {
            const defaults = [path.join(os.homedir(), ".ssh", "id_ed25519"), path.join(os.homedir(), ".ssh", "id_rsa")];
            for (const p of defaults) {
                if (fs.existsSync(p)) {
                    keyPath = p;
                    break;
                }
            }
        }
        if (keyPath) {
            if (keyPath.startsWith("~"))
                keyPath = path.join(os.homedir(), keyPath.slice(1));
            if (fs.existsSync(keyPath)) {
                config.privateKey = fs.readFileSync(keyPath);
                if (auth.passphrase)
                    config.passphrase = auth.passphrase;
            }
        }
    }
    const { Client: ClientCtor } = await loadSsh2();
    return new Promise((resolve, reject) => {
        const conn = new ClientCtor();
        conn.on("ready", () => resolve(conn)).on("error", (err) => reject(new Error(`SSH_CONN_FAILED: ${err.message}`))).connect(config);
    });
}
export async function sshProbe(host, port = 22, auth = { type: "key" }) {
    const conn = await getConnection(host, port, auth);
    try {
        const cmd = "whoami; hostname; pwd; uname -a; id";
        return await new Promise((resolve, reject) => {
            conn.exec(cmd, (err, stream) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }
                let out = "";
                stream.on("close", () => { conn.end(); resolve(out); })
                    .on("data", (data) => out += data.toString())
                    .stderr.on("data", (data) => out += data.toString());
            });
        });
    }
    catch (e) {
        conn.end();
        throw e;
    }
}
export async function sshExec(host, command, cwd, port = 22, auth = { type: "key" }, timeout = 60000) {
    // Жёсткая защита от катастрофических команд (отказ без запроса подтверждения)
    const CATASTROPHIC_PATTERNS = [
        /rm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+\/(?:\s|$|\*)/i, // rm -rf /, rm -rf /*
        /rm\s+-rf\s+--no-preserve-root\s+\//i,
        /rm\s+-rf\s+(?:\/etc|\/boot|\/var|\/usr|\/bin|\/sbin|\/lib|~|\$HOME)(?:\s|$|\/)/i, // удаление критических папок
        /\bmkfs(?:\.[a-zA-Z0-9]+)?\b/i, // mkfs, mkfs.ext4
        /\bdd\b.*\bof=\/dev\/(?:sd|hd|nvme|vd|mmcblk|xvd)/i, // запись напрямую на диск
        /\b(?:echo|cat|tee)\b.*>\s*\/dev\/(?:sd|hd|nvme|vd|mmcblk|xvd)/i,
        /:﴾﴿\s*{\s*:\|:&\s*};:/i, // fork bomb
        /chmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+777\s+\/(?:\s|$)/i,
        /(?:echo|cat|printf)\s+.*>\s*\/etc\/(?:passwd|shadow|sudoers)/i, // перезапись ключевых файлов
        /\binit\s+0\b/i, // немедленное выключение
        /\bshutdown\b/i,
        /\breboot\b/i,
        /\bpoweroff\b/i,
        /\bhalt\b/i
    ];
    for (const pattern of CATASTROPHIC_PATTERNS) {
        if (pattern.test(command)) {
            throw new Error("COMMAND_BLOCKED: catastrophic command (server destruction attempt)");
        }
    }
    // Спрашиваем подтверждение, если команда потенциально мутирующая
    const isReadOnly = /^(cat|ls|ps|ss|df|du|free|uname|id|whoami|ip\s+[ar]|journalctl|systemctl\s+status|docker\s+ps|git\s+(status|log|diff))/.test(command.trim());
    if (!isReadOnly) {
        // Если не TTY, пропускаем подтверждение (для автоматизации)
        if (process.stdin.isTTY) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const ans = await rl.question(`\n[SSH MUTATION] ${host}: ${command}\nВыполнить? (y/N) `);
            rl.close();
            if (ans.toLowerCase() !== "y")
                throw new Error("COMMAND_DENIED: user denied");
        }
        else {
            // non-TTY: по умолчанию ЗАПРЕЩАЕМ мутации. Разрешить можно только явным флагом.
            if (process.env.DUB_SSH_ALLOW_NON_TTY_MUTATIONS === "true") {
                console.warn(`\n[WARN] SSH mutation allowed by DUB_SSH_ALLOW_NON_TTY_MUTATIONS: ${host}: ${command}`);
            }
            else {
                throw new Error("COMMAND_DENIED: mutation requires TTY confirmation. " +
                    "Run via run.bat (TTY), or set DUB_SSH_ALLOW_NON_TTY_MUTATIONS=true (dangerous).");
            }
        }
    }
    const conn = await getConnection(host, port, auth);
    try {
        const finalCmd = cwd ? `cd ${cwd} && (${command})` : command;
        return await new Promise((resolve, reject) => {
            conn.exec(finalCmd, (err, stream) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }
                let stdout = "";
                let stderr = "";
                stream.on("close", (code) => {
                    conn.end();
                    resolve(`exitCode: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
                }).on("data", (data) => stdout += data.toString())
                    .stderr.on("data", (data) => stderr += data.toString());
            });
        });
    }
    catch (e) {
        conn.end();
        throw e;
    }
}
const FORBIDDEN_WRITE_PATHS = [
    /^\/etc(?:\/|$)/i,
    /^\/boot(?:\/|$)/i,
    /^\/usr(?:\/|$)/i,
    /^\/var\/lib(?:\/|$)/i,
    /^\/var\/log(?:\/|$)/i,
    /^\/root(?:\/|$)/i,
    /^\/bin(?:\/|$)/i,
    /^\/sbin(?:\/|$)/i,
    /^\/lib(?:\/|$)/i,
    /^\/dev(?:\/|$)/i,
    /^\/proc(?:\/|$)/i,
    /^\/sys(?:\/|$)/i,
    /^\/var\/run(?:\/|$)/i,
];
export async function sshCopy(host, direction, src, dst, port = 22, auth = { type: "key" }, overwrite = false, timeout = 300000) {
    // Блок-лист на запись в системные пути (только для direction=up)
    if (direction === "up") {
        const norm = dst.replace(/\\/g, "/");
        for (const p of FORBIDDEN_WRITE_PATHS) {
            if (p.test(norm)) {
                throw new Error(`COMMAND_BLOCKED: destination path '${dst}' is in a system directory (write forbidden)`);
            }
        }
    }
    const conn = await getConnection(host, port, auth);
    try {
        return await new Promise((resolve, reject) => {
            conn.sftp((err, sftp) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }
                if (direction === "up") {
                    if (!fs.existsSync(src)) {
                        conn.end();
                        return reject(new Error(`NOT_FOUND: ${src}`));
                    }
                    sftp.fastPut(src, dst, (err) => {
                        conn.end();
                        if (err)
                            reject(err);
                        else
                            resolve(`OK: uploaded ${src} -> ${dst}`);
                    });
                }
                else {
                    if (!overwrite && fs.existsSync(dst)) {
                        conn.end();
                        return reject(new Error(`NO_CHANGE: ${dst} exists and overwrite=false`));
                    }
                    sftp.fastGet(src, dst, (err) => {
                        conn.end();
                        if (err)
                            reject(err);
                        else
                            resolve(`OK: downloaded ${src} -> ${dst}`);
                    });
                }
            });
        });
    }
    catch (e) {
        conn.end();
        throw e;
    }
}
//# sourceMappingURL=ssh.js.map