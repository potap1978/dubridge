import { Client } from "ssh2";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";

interface AuthConfig {
  type: "key" | "password";
  key?: string;
  passphrase?: string;
  password?: string;
  password_env?: string;
}

async function getConnection(host: string, port: number = 22, auth: AuthConfig = { type: "key" }): Promise<Client> {
  let user = "";
  let hostname = host;
  if (host.includes("@")) {
    [user, hostname] = host.split("@");
  }

  const config: any = {
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
    if (!config.password) throw new Error("SSH_PASS_REQUIRED: password or password_env not set");
  } else {
    let keyPath = auth.key;
    if (!keyPath) {
      const defaults = [path.join(os.homedir(), ".ssh", "id_ed25519"), path.join(os.homedir(), ".ssh", "id_rsa")];
      for (const p of defaults) {
        if (fs.existsSync(p)) { keyPath = p; break; }
      }
    }
    if (keyPath) {
      if (keyPath.startsWith("~")) keyPath = path.join(os.homedir(), keyPath.slice(1));
      if (fs.existsSync(keyPath)) {
        config.privateKey = fs.readFileSync(keyPath);
        if (auth.passphrase) config.passphrase = auth.passphrase;
      }
    }
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => resolve(conn)).on("error", (err) => reject(new Error(`SSH_CONN_FAILED: ${err.message}`))).connect(config);
  });
}

export async function sshProbe(host: string, port: number = 22, auth: AuthConfig = { type: "key" }): Promise<string> {
  const conn = await getConnection(host, port, auth);
  try {
    const cmd = "whoami; hostname; pwd; uname -a; id";
    return await new Promise((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let out = "";
        stream.on("close", () => { conn.end(); resolve(out); })
              .on("data", (data: any) => out += data.toString())
              .stderr.on("data", (data: any) => out += data.toString());
      });
    });
  } catch (e) {
    conn.end();
    throw e;
  }
}

export async function sshExec(host: string, command: string, cwd?: string, port: number = 22, auth: AuthConfig = { type: "key" }, timeout: number = 60000): Promise<string> {
  // Простейшая защита от катастрофических команд
  if (/rm\s+-rf\s+\//.test(command) || /\bmkfs\b/.test(command)) {
    throw new Error("COMMAND_BLOCKED: catastrophic command");
  }

  // Спрашиваем подтверждение, если команда потенциально мутирующая
  const isReadOnly = /^(cat|ls|ps|ss|df|du|free|uname|id|whoami|ip\s+[ar]|journalctl|systemctl\s+status|docker\s+ps|git\s+(status|log|diff))/.test(command.trim());
  
  if (!isReadOnly) {
    // Если не TTY, пропускаем подтверждение (для автоматизации)
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = await rl.question(`\n[SSH MUTATION] ${host}: ${command}\nВыполнить? (y/N) `);
      rl.close();
      if (ans.toLowerCase() !== "y") throw new Error("COMMAND_DENIED: user denied");
    } else {
      console.warn(`\n[WARN] SSH mutation without confirmation (non-TTY): ${host}: ${command}`);
    }
  }

  const conn = await getConnection(host, port, auth);
  try {
    const finalCmd = cwd ? `cd ${cwd} && (${command})` : command;
    return await new Promise((resolve, reject) => {
      conn.exec(finalCmd, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let stdout = "";
        let stderr = "";
        stream.on("close", (code: number) => {
          conn.end();
          resolve(`exitCode: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        }).on("data", (data: any) => stdout += data.toString())
          .stderr.on("data", (data: any) => stderr += data.toString());
      });
    });
  } catch (e) {
    conn.end();
    throw e;
  }
}

export async function sshCopy(host: string, direction: "up" | "down", src: string, dst: string, port: number = 22, auth: AuthConfig = { type: "key" }, overwrite: boolean = false, timeout: number = 300000): Promise<string> {
  const conn = await getConnection(host, port, auth);
  try {
    return await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        
        if (direction === "up") {
          if (!fs.existsSync(src)) { conn.end(); return reject(new Error(`NOT_FOUND: ${src}`)); }
          sftp.fastPut(src, dst, (err) => {
            conn.end();
            if (err) reject(err);
            else resolve(`OK: uploaded ${src} -> ${dst}`);
          });
        } else {
          if (!overwrite && fs.existsSync(dst)) { conn.end(); return reject(new Error(`NO_CHANGE: ${dst} exists and overwrite=false`)); }
          sftp.fastGet(src, dst, (err) => {
            conn.end();
            if (err) reject(err);
            else resolve(`OK: downloaded ${src} -> ${dst}`);
          });
        }
      });
    });
  } catch (e) {
    conn.end();
    throw e;
  }
}
