// Shared by provisioning and native launch validation: never provision an unqualified "latest" CLI.
// `packages` pins the exact vendor artifact per target; vendor metadata must match it. Bump all four
// digests together with the version (docs/operations/supply-chain.md).
export const RUNTIMES = { codex: { binary: 'codex', version: '0.153.3', home: '.codex', skills: '.agents/skills', env: 'CODEX_HOME',
    packages: { 'darwin-arm64': { sha256: '1101ce8b7f9aaf598120bf14ff260c5f591eaa2c611cf8738070529e60ae8105', size: 111544763 },
      'linux-x64': { sha256: '47bb1fb36fb1dbd5fe1af3eb0db422ffb4c3c38d9c1762c7618a9bed46c44a63', size: 126189723 } } },
  claude_code: { binary: 'claude', version: '2.1.224', home: '.claude', skills: '.claude/skills', env: 'CLAUDE_CONFIG_DIR',
    packages: { 'darwin-arm64': { sha256: '391df9d2ab04e4cf32199335720ac7715a582e91eaecfd4d2198a16f57ea59b3', size: 277495040 },
      'linux-x64': { sha256: 'a2b5add7dc4bcd8eaa029f4e8bdac4df7769b4073698db7989d206baf9419c2d', size: 295676936 } } } } as const;
