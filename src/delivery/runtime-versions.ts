// Shared by provisioning and native launch validation: never provision an unqualified "latest" CLI.
export const RUNTIMES = { codex: { binary: 'codex', version: '0.153.3', home: '.codex', skills: '.agents/skills', env: 'CODEX_HOME' },
  claude_code: { binary: 'claude', version: '2.1.224', home: '.claude', skills: '.claude/skills', env: 'CLAUDE_CONFIG_DIR' } } as const;
