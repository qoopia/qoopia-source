import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addWakeRunnerAgent, wakeRunnerHealth, wakeRunnerService } from "../src/delivery/wake-runner.ts";
import { cliCommandCheck, linuxSandboxCheck } from "../src/delivery/doctor-checks.ts";

test("doctor follows the wake runner: not configured, configured but not installed, running, outdated, not running [A7-03, A7-12]", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-doctor-wr-")));
  try {
    const data = path.join(home, "data"), config = path.join(data, "wake-runner", "config.json");
    expect(wakeRunnerHealth(data, "darwin", home)).toMatchObject({ status: "pass", reason: "WAKE_RUNNER_NOT_CONFIGURED" });
    fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
    addWakeRunnerAgent(config, { server: "https://mcp.example", host: "127.0.0.1", port: "8790", agent_id: "A1", name: "Agent", runtime: "claude_code", command: "/bin/sh", cwd: home });
    expect(wakeRunnerHealth(data, "darwin", home)).toMatchObject({ status: "fail", reason: "WAKE_RUNNER_NOT_INSTALLED" });

    const binary = path.join(home, "qoopia"); fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
    const service = wakeRunnerService(binary, config, "darwin", home);
    fs.mkdirSync(path.dirname(service.file), { recursive: true }); fs.writeFileSync(service.file, service.bytes);
    const loaded = (pid: string, stderr = path.join(path.dirname(config), "wake-runner.err")) => (command: string, args: string[]) =>
      command === "/bin/launchctl" ? { status: 0, stdout: `\tstate = running\n\tprogram = ${binary}\n\tstderr path = ${stderr}\n\tpid = ${pid}\n\tlast exit code = 0\n` }
        : args.includes("etime=") ? { status: 0, stdout: "00:30\n" } : { status: 1, stdout: "" };
    // The binary was replaced (ctime) before the process started 30 s ago: current.
    const old = new Date(Date.now() - 3_600_000); fs.utimesSync(binary, old, old);
    const aged = (command: string, args: string[]) => args.includes("etime=") ? { status: 0, stdout: "01-00:00:00\n" } : loaded("123")(command, args);
    expect(wakeRunnerHealth(data, "darwin", home, aged)).toMatchObject({ status: "fail", reason: "WAKE_RUNNER_OUTDATED" });
    expect(wakeRunnerHealth(data, "darwin", home, aged).action).toContain("launchctl kickstart -k");
    // A process younger than the binary's last change runs the current binary.
    const fresh = (command: string, args: string[]) => args.includes("etime=") ? { status: 0, stdout: "00:00\n" } : loaded("123")(command, args);
    expect(wakeRunnerHealth(data, "darwin", home, fresh)).toMatchObject({ status: "pass", reason: "WAKE_RUNNER_RUNNING", agents: 1 });
    expect(wakeRunnerHealth(data, "darwin", home, (c, a) => a.includes("etime=") ? { status: 0, stdout: "00:00\n" } : loaded("123", "/elsewhere/service.err")(c, a)))
      .toMatchObject({ status: "warn", reason: "WAKE_RUNNER_JOB_DIFFERS" });
    expect(wakeRunnerHealth(data, "darwin", home, loaded(""))).toMatchObject({ status: "fail", reason: "WAKE_RUNNER_NOT_RUNNING" });
    expect(wakeRunnerHealth(data, "darwin", home, () => ({ status: 113, stdout: "" }))).toMatchObject({ status: "fail", reason: "WAKE_RUNNER_NOT_LOADED" });
    fs.rmSync(binary);
    expect(wakeRunnerHealth(data, "darwin", home, fresh)).toMatchObject({ status: "fail", reason: "WAKE_RUNNER_BINARY_MISSING" });
    expect(JSON.stringify(wakeRunnerHealth(data, "darwin", home, fresh))).not.toContain(home);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("doctor names the link that puts qoopia on PATH, without the owner's home path [A7-13]", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-doctor-cli-"))), root = path.join(home, "data");
  try {
    fs.mkdirSync(path.join(root, "bin"), { recursive: true }); fs.writeFileSync(path.join(root, "bin", "qoopia"), "#!/bin/sh\n", { mode: 0o755 });
    const missing = cliCommandCheck(root, "/Applications/Qoopia.app/Contents/Resources/bundle/qoopia", { PATH: "/usr/bin:/bin" }, home);
    expect(missing).toMatchObject({ status: "warn", reason: "QOOPIA_NOT_ON_PATH" });
    expect(missing.action).toContain('ln -sf "$HOME/data/bin/qoopia" "$HOME/.local/bin/qoopia"');
    expect(cliCommandCheck(root, "/x/qoopia", { PATH: path.join(root, "bin") }, home)).toMatchObject({ status: "pass" });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("a Linux sandbox that cannot start is a doctor failure with the step to fix it [A7-07]", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-doctor-bwrap-")), wrapper = path.join(dir, "bwrap");
  try {
    fs.writeFileSync(wrapper, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(linuxSandboxCheck(wrapper, "darwin")).toMatchObject({ status: "pass", reason: "SANDBOX_NOT_USED" });
    expect(linuxSandboxCheck(wrapper, "linux", () => ({ status: 1 }) as any)).toMatchObject({ status: "fail" });
    expect(linuxSandboxCheck(wrapper, "linux", () => ({ status: 0 }) as any)).toMatchObject({ status: "pass", reason: "SANDBOX_STARTS" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the protocol and instructions default to the installation's language, not always Russian [A6-11]", async () => {
  const { installationLanguage } = await import("../src/agent-kit/index.ts");
  expect(installationLanguage({ LANG: "en_US.UTF-8" })).toBe("en");
  expect(installationLanguage({ LANG: "ru_RU.UTF-8" })).toBe("ru");
  expect(installationLanguage({})).toBe("en");
  expect(installationLanguage({ LANG: "en_US.UTF-8", QOOPIA_LANGUAGE: "ru" })).toBe("ru");
  expect(fs.readFileSync("scripts/darwin-launcher.swift", "utf8")).toContain('environment["QOOPIA_LANGUAGE"] = ru ? "ru" : "en"');
});

test("install refuses root early with the step to take [A6-07]", async () => {
  const { inspectInstallationRequirements, requirementsRefusal } = await import("../src/delivery/requirements.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-root-req-"));
  try {
    const asRoot = inspectInstallationRequirements({ root: dir, manifest: { members: {} } }, dir, null, "linux-x64", 0);
    expect(asRoot).toMatchObject({ ok: false, blockers: ["ROOT_USER"] });
    expect(requirementsRefusal(asRoot.blockers)).toContain("adduser");
    expect(inspectInstallationRequirements({ root: dir, manifest: { members: {} } }, dir, null, "linux-x64", 1000).ok).toBe(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a command given to the Mac app binary runs the bundled qoopia and exits, instead of starting the app [A5-18]", () => {
  const swift = fs.readFileSync("scripts/darwin-launcher.swift", "utf8");
  expect(swift.indexOf('appendingPathComponent("bundle/qoopia")\n    command.arguments = cliArguments')).toBeGreaterThan(0);
  expect(swift.indexOf("exit(command.terminationStatus)")).toBeLessThan(swift.indexOf("let app = NSApplication.shared"));
});

test("Linux names a newer public release, and says nothing when current or offline [A6-05]", async () => {
  const { linuxUpdateNotice } = await import("../src/delivery/desktop-update.ts");
  const feed = (version: string) => (async () => Response.json({ version })) as unknown as typeof fetch;
  expect((await linuxUpdateNotice("5.0.20", feed("5.0.21")))?.next_action).toContain("./qoopia open from the new folder");
  expect(await linuxUpdateNotice("5.0.21", feed("5.0.21"))).toBeNull();
  expect(await linuxUpdateNotice("5.0.21", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
});

test("the bundled bwrap loads its libraries for itself only, and defers to the system bwrap under AppArmor's userns rule [A7-07]", async () => {
  const { BWRAP_WRAPPER } = await import("../scripts/prepare-linux-support.ts");
  expect(BWRAP_WRAPPER).not.toContain("LD_LIBRARY_PATH");
  expect(BWRAP_WRAPPER).toContain('--library-path "$dir/lib" "$dir/bwrap.bin" "$@"');
  expect(BWRAP_WRAPPER).toContain("apparmor_restrict_unprivileged_userns");
});
