#!/usr/bin/env python3
"""Refresh the Corsair bare mirror straight from Forgejo (source of truth) and the release consumer."""
import argparse, json, os, subprocess, time
from pathlib import Path

def run(args):
    # The operator's home holds the Git credential helper; no name of it belongs in the public source.
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=120, text=True,
                                   env={"GIT_TERMINAL_PROMPT": "0", "HOME": os.environ.get("HOME", "/"), "PATH": "/usr/bin:/bin"}).strip()

def sync(mirror, consumer):
    if run(["git", "-C", str(mirror), "rev-parse", "--is-bare-repository"]) != "true":
        raise ValueError("Only a bare mirror may be synced")
    remote_main = run(["git", "-C", str(mirror), "ls-remote", "origin", "refs/heads/main"]).split()[0]
    run(["git", "-C", str(mirror), "fetch", "--prune", "--force", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"])
    mirror_main = run(["git", "-C", str(mirror), "rev-parse", "refs/heads/main"])
    out = {"status": "OK", "checked_at": time.time(), "remote_main": remote_main, "mirror_main": mirror_main}
    if consumer:
        run(["git", "-C", str(consumer), "fetch", "--prune", "origin"])
        out["consumer_main"] = run(["git", "-C", str(consumer), "rev-parse", "refs/remotes/origin/main"])
    if len({v for k, v in out.items() if k.endswith("_main")}) != 1:
        raise ValueError("Forgejo, mirror and release consumer disagree")
    return out

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--mirror", type=Path, required=True)
    p.add_argument("--consumer", type=Path)
    a = p.parse_args()
    try:
        result = sync(a.mirror, a.consumer)
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        result = {"status": "ERROR", "checked_at": time.time()}
    tmp = a.mirror / "sync-status.tmp"; tmp.write_text(json.dumps(result) + "\n"); tmp.replace(a.mirror / "sync-status.json")
    print(json.dumps(result)); raise SystemExit(0 if result["status"] == "OK" else 1)
