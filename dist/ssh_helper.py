#!/usr/bin/env python3
"""dubridge SSH helper.

Читает одно JSON-задание из STDIN, пишет ровно одну JSON-строку в STDOUT.
Действия: resolve | probe | exec | copy.
Зависимость: paramiko (pip install paramiko).
"""

import json
import os
import posixpath
import socket
import sys
import time

PARAMIKO_IMPORT_ERROR = None
paramiko = None
try:
    import paramiko as _paramiko

    paramiko = _paramiko
except Exception as exc:  # noqa: BLE001 - сообщение уходит в ответ инструмента
    PARAMIKO_IMPORT_ERROR = "%s: %s" % (type(exc).__name__, exc)

READ_CHUNK = 65536
PROBE_UNAME_TIMEOUT = 15
MAX_RAW = 512 * 1024


class ToolError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def emit(payload):
    try:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def fail(code, message, **extra):
    payload = {"ok": False, "error": str(code), "message": str(message)}
    payload.update(extra)
    emit(payload)
    raise SystemExit(0)


def succeed(**extra):
    payload = {"ok": True}
    payload.update(extra)
    emit(payload)
    raise SystemExit(0)


def require_paramiko():
    if paramiko is None:
        raise ToolError(
            "SSH_CONN_FAILED",
            "Python найден, но пакет paramiko не установлен: выполните "
            "`python -m pip install paramiko` (%s)" % (PARAMIKO_IMPORT_ERROR or ""),
        )


def expand(path_value):
    if not path_value:
        return path_value
    return os.path.expandvars(os.path.expanduser(str(path_value)))


def sh_quote(value):
    return "'" + str(value).replace("'", "'\\''") + "'"


class GatedPolicy(paramiko.MissingHostKeyPolicy if paramiko else object):
    """Пропускает ключ только если он совпал с тем, что подтвердил оператор."""

    def __init__(self, expected_keys):
        self.expected_keys = set(expected_keys or [])

    def missing_host_key(self, client, hostname, key):
        line = "%s %s" % (key.get_name(), key.get_base64())
        if line in self.expected_keys:
            return
        raise ToolError(
            "SSH_HOST_KEY_UNKNOWN",
            "ключ сервера %s (%s) не совпадает с записью known_hosts - соединение закрыто"
            % (hostname, key.get_name()),
        )


def action_resolve(job):
    require_paramiko()
    alias = job.get("host") or ""
    config_path = os.path.expanduser("~/.ssh/config")
    cfg = paramiko.SSHConfig()
    if os.path.isfile(config_path):
        try:
            cfg.from_path(config_path)
        except AttributeError:
            with open(config_path, "r", errors="replace") as handle:
                cfg.from_file(handle)
        except Exception:
            pass
    try:
        found = cfg.lookup(alias) or {}
    except Exception:
        found = {}

    identity_files = found.get("identityfile") or []
    if isinstance(identity_files, str):
        identity_files = [identity_files]
    proxy = found.get("proxyjump") or found.get("proxycommand") or None
    if isinstance(proxy, list):
        proxy = proxy[0] if proxy else None

    port_raw = found.get("port")
    try:
        port = int(port_raw) if port_raw else 22
    except (TypeError, ValueError):
        port = 22

    succeed(
        resolved={
            "hostname": found.get("hostname") or alias,
            "user": found.get("user") or None,
            "port": port,
            "identity_files": [expand(item) for item in identity_files if item],
            "proxy": proxy,
        }
    )


def translate_exception(exc):
    """paramiko-исключения -> коды ошибок dubridge."""
    if isinstance(exc, ToolError):
        return exc
    if isinstance(exc, paramiko.AuthenticationException):
        return ToolError(
            "SSH_AUTH_FAILED",
            "аутентификация отклонена сервером: %s" % exc,
        )
    if isinstance(exc, paramiko.BadHostKeyException):
        return ToolError(
            "SSH_HOST_KEY_UNKNOWN",
            "ключ сервера не совпадает с known_hosts: %s" % exc,
        )
    if isinstance(exc, socket.timeout):
        return ToolError("SSH_TIMEOUT", "таймаут соединения: %s" % exc)
    if isinstance(exc, EOFError):
        return ToolError("SSH_CONN_FAILED", "сервер оборвал соединение: %s" % exc)
    if isinstance(exc, OSError) and getattr(exc, "errno", None) in (111, 61, 110):
        return ToolError("SSH_CONN_FAILED", "соединение отклонено: %s" % exc)
    if isinstance(exc, paramiko.SSHException):
        text = str(exc).lower()
        if "timed out" in text or "timeout" in text:
            return ToolError("SSH_TIMEOUT", "таймаут SSH: %s" % exc)
        if "unknown host key" in text or "host key" in text:
            return ToolError("SSH_HOST_KEY_UNKNOWN", str(exc))
        return ToolError("SSH_CONN_FAILED", "ошибка SSH: %s" % exc)
    return ToolError("SSH_CONN_FAILED", "%s: %s" % (type(exc).__name__, exc))


def open_client(job):
    require_paramiko()
    resolved = job.get("resolved") or {}
    auth = job.get("auth") or {}
    if resolved.get("proxy"):
        raise ToolError(
            "COMMAND_DENIED",
            "ProxyJump/ProxyCommand в ~/.ssh/config запрещены правилом 11 (без туннелей "
            "и пробросов): %s" % resolved.get("proxy"),
        )
    hostname = resolved.get("hostname") or job.get("host")
    try:
        port = int(resolved.get("port") or job.get("port") or 22)
    except (TypeError, ValueError):
        port = 22
    username = job.get("user") or resolved.get("user")
    timeout_s = max(3.0, min(float(job.get("timeout_ms") or 60000) / 1000.0, 120.0))

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(GatedPolicy(job.get("expected_keys")))
    kwargs = {
        "hostname": hostname,
        "port": port,
        "username": username,
        "timeout": timeout_s,
        "banner_timeout": timeout_s,
        "auth_timeout": timeout_s,
        "allow_agent": False,
        "look_for_keys": False,
        "compress": False,
    }
    key_files = auth.get("key_files") or []
    if key_files:
        kwargs["key_filename"] = list(key_files)
    if auth.get("password"):
        kwargs["password"] = auth.get("password")
    if auth.get("passphrase"):
        kwargs["passphrase"] = auth.get("passphrase")
    try:
        client.connect(**kwargs)
    except Exception as exc:  # noqa: BLE001
        client.close()
        raise translate_exception(exc)
    return client


def run_once(client, command, timeout_s):
    """Выполняет команду, возвращает (exit_code, stdout, stderr, timed_out)."""
    deadline = time.time() + timeout_s
    stdout = []
    stderr = []
    total = 0
    timed_out = False
    exit_status = None
    channel = None
    try:
        transport = client.get_transport()
        if transport is None:
            raise ToolError("SSH_CONN_FAILED", "транспорт закрыт")
        channel = transport.open_session()
        channel.settimeout(min(timeout_s, 30.0))
        channel.exec_command(command)
        while True:
            progressed = False
            if channel.recv_ready():
                chunk = channel.recv(READ_CHUNK)
                if chunk:
                    stdout.append(chunk)
                    total += len(chunk)
                    progressed = True
            if channel.recv_stderr_ready():
                chunk = channel.recv_stderr(READ_CHUNK)
                if chunk:
                    stderr.append(chunk)
                    total += len(chunk)
                    progressed = True
            if channel.exit_status_ready():
                while channel.recv_ready():
                    chunk = channel.recv(READ_CHUNK)
                    if not chunk:
                        break
                    stdout.append(chunk)
                while channel.recv_stderr_ready():
                    chunk = channel.recv_stderr(READ_CHUNK)
                    if not chunk:
                        break
                    stderr.append(chunk)
                exit_status = channel.recv_exit_status()
                break
            if time.time() > deadline:
                timed_out = True
                break
            if not progressed:
                time.sleep(0.02)
            if total > MAX_RAW:
                break
    finally:
        if channel is not None:
            try:
                channel.close()
            except Exception:
                pass
    out = b"".join(stdout)[:MAX_RAW].decode("utf-8", "replace")
    err = b"".join(stderr)[:MAX_RAW].decode("utf-8", "replace")
    return exit_status, out, err, timed_out


def run_with_timeout(client, command, timeout_s):
    try:
        return run_once(client, command, timeout_s)
    except ToolError:
        raise
    except socket.timeout:
        return None, "", "", True
    except Exception as exc:  # noqa: BLE001
        raise translate_exception(exc)


def detect_remote_os(client):
    code, out, _, timed_out = run_with_timeout(client, "uname -a", PROBE_UNAME_TIMEOUT)
    if not timed_out and code == 0 and out.strip():
        lowered = out.lower()
        if "darwin" in lowered:
            return "darwin", out.strip()
        if "linux" in lowered:
            return "linux", out.strip()
        return "unix", out.strip()
    code, out, _, timed_out = run_with_timeout(client, "cmd /c ver", PROBE_UNAME_TIMEOUT)
    if not timed_out and code == 0 and "windows" in out.lower():
        return "windows", out.strip()
    return "unknown", (out or "").strip()


def probe_payload(remote_os, kernel, out, err, exit_code, timed_out):
    lines = [line.strip() for line in (out or "").splitlines() if line.strip()]
    payload = {
        "remote_os": remote_os,
        "kernel": kernel,
        "user": lines[0] if len(lines) > 0 else "",
        "hostname": lines[1] if len(lines) > 1 else "",
        "cwd": lines[2] if len(lines) > 2 else "",
        "identity": " ".join(lines[3:]) if len(lines) > 3 else "",
        "exit_code": exit_code,
        "timed_out": timed_out,
        "raw": (out or "").strip(),
        "stderr": (err or "").strip(),
    }
    return payload


def do_probe(client, timeout_s):
    remote_os, kernel = detect_remote_os(client)
    if remote_os == "windows":
        command = "whoami & hostname & cd & ver"
    else:
        command = "whoami; hostname; pwd; uname -a; id"
    code, out, err, timed_out = run_with_timeout(client, command, timeout_s)
    return probe_payload(remote_os, kernel, out, err, code, timed_out)


def build_command(command, cwd, remote_os):
    if not cwd:
        return command
    if remote_os == "windows":
        return 'cd /d "%s" && %s' % (str(cwd).replace('"', ""), command)
    return "cd -- %s && ( %s )" % (sh_quote(cwd), command)


def action_probe(job, client):
    probe = do_probe(client, max(15.0, min(float(job.get("timeout_ms") or 30000) / 1000.0, 60.0)))
    succeed(probe=probe)


def action_exec(job, client):
    probe = None
    if job.get("probe_first"):
        probe = do_probe(client, 15.0)
    remote_os = (probe or {}).get("remote_os") or job.get("remote_os") or "unknown"
    remote_command = build_command(job.get("command") or "", job.get("cwd"), remote_os)
    timeout_s = max(3.0, min(float(job.get("timeout_ms") or 60000) / 1000.0, 600.0))
    started = time.time()
    code, out, err, timed_out = run_with_timeout(client, remote_command, timeout_s)
    duration_ms = int((time.time() - started) * 1000)
    succeed(
        probe=probe,
        remote_os=remote_os,
        remote_command=remote_command,
        stdout=out,
        stderr=err,
        exit_code=code,
        timed_out=timed_out,
        duration_ms=duration_ms,
    )


def normalize_remote_path(sftp, value):
    value = str(value or "").strip()
    if not value:
        raise ToolError("INVALID_ARGS", "пустой путь")
    if value.startswith("/") or (len(value) > 1 and value[1] == ":"):
        return value
    try:
        base = sftp.normalize(".")
    except Exception:
        base = ""
    return posixpath.join(base, value) if base else value


def remote_makedirs(sftp, directory):
    parts = []
    current = directory.rstrip("/")
    while current not in ("", "/"):
        parts.append(current)
        current = posixpath.dirname(current)
        if current == posixpath.dirname(current):
            break
    for item in reversed(parts):
        if not item:
            continue
        try:
            sftp.stat(item)
        except (IOError, OSError, FileNotFoundError):
            try:
                sftp.mkdir(item)
            except (IOError, OSError):
                pass


def remote_exists(sftp, path):
    try:
        sftp.stat(path)
        return True
    except (IOError, OSError, FileNotFoundError):
        return False


def action_copy(job, client, local_root):
    if job.get("probe_first"):
        do_probe(client, 15.0)
    channel_timeout = max(15.0, min(float(job.get("timeout_ms") or 300000) / 1000.0, 3600.0))
    try:
        sftp = paramiko.SFTPClient.from_transport(client.get_transport())
        sftp.get_channel().settimeout(channel_timeout)
    except Exception as exc:  # noqa: BLE001
        raise translate_exception(exc)

    direction = job.get("direction")
    overwrite = bool(job.get("overwrite"))
    started = time.time()
    try:
        if direction == "up":
            local_src = job.get("local_src")
            remote_dst = normalize_remote_path(sftp, job.get("dst"))
            parent = posixpath.dirname(remote_dst)
            if parent and not remote_exists(sftp, parent):
                if job.get("create_dirs"):
                    remote_makedirs(sftp, parent)
                else:
                    raise ToolError(
                        "NOT_FOUND",
                        "каталог назначения не существует на хосте: %s - создайте его "
                        "через ssh_exec (mkdir -p)" % parent,
                    )
            if remote_exists(sftp, remote_dst) and not overwrite:
                raise ToolError(
                    "NO_CHANGE",
                    "файл уже существует: %s - передайте overwrite:true, чтобы перезаписать"
                    % remote_dst,
                )
            sftp.put(local_src, remote_dst)
            size = sftp.stat(remote_dst).st_size
            succeed(
                direction="up",
                local_src=local_src,
                remote_path=remote_dst,
                bytes=size,
                duration_ms=int((time.time() - started) * 1000),
            )

        if direction == "down":
            remote_src = normalize_remote_path(sftp, job.get("src"))
            local_dst = job.get("local_dst")
            if not remote_exists(sftp, remote_src):
                raise ToolError("NOT_FOUND", "файл не найден на хосте: %s" % remote_src)
            size = sftp.stat(remote_src).st_size
            part = local_dst + ".dubridge-part"
            try:
                sftp.get(remote_src, part)
                os.replace(part, local_dst)
            finally:
                if os.path.exists(part):
                    try:
                        os.remove(part)
                    except OSError:
                        pass
            succeed(
                direction="down",
                remote_src=remote_src,
                local_dst=local_dst,
                bytes=size,
                duration_ms=int((time.time() - started) * 1000),
            )

        raise ToolError("INVALID_ARGS", "direction должен быть up или down")
    finally:
        try:
            sftp.close()
        except Exception:
            pass


def read_job():
    raw = sys.stdin.read()
    if not raw.strip():
        raise ToolError("INVALID_ARGS", "пустое задание")
    try:
        return json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        raise ToolError("INVALID_ARGS", "некорректный JSON задания: %s" % exc)


def main():
    job = read_job()
    action = job.get("action")
    if action == "resolve":
        action_resolve(job)
        return

    client = open_client(job)
    try:
        if action == "probe":
            action_probe(job, client)
        elif action == "exec":
            action_exec(job, client)
        elif action == "copy":
            action_copy(job, client, job.get("local_root"))
        else:
            raise ToolError("INVALID_ARGS", "неизвестное действие: %s" % action)
    finally:
        try:
            client.close()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except ToolError as exc:
        fail(exc.code, exc.message)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        fail("SSH_CONN_FAILED", "%s: %s" % (type(exc).__name__, exc))
