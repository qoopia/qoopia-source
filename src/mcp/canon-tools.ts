/**
 * Canon over MCP. Hooks, brief and wakes load canons without a call; these tools write them,
 * read them, and let a client without lifecycle hooks (ChatGPT, Claude Web) ask which canons a
 * turn calls for. Every tool pins the workspace from the caller's authentication.
 */
import { z } from "zod";
import type { ToolDef } from "./tools.ts";
import { CANON_MAX_CHARS, CANON_MODES, CANON_SCOPES, createCanon, getCanon, listCanons, matchCanons, renderCanon, retireCanon, updateCanon } from "../services/canon.ts";

const triggers = z.object({
  words: z.array(z.string().min(1).max(120)).max(20).optional(),
  projects: z.array(z.string().min(1).max(120)).max(10).optional(),
  tools: z.array(z.string().min(1).max(120)).max(10).optional(),
  files: z.array(z.string().min(1).max(120)).max(10).optional(),
}).strict().describe("When the rule matters: words of the turn, project names, tools and files it names. Omit to let the server suggest them from the rule's text.");

const actor = (auth: { agent_id: string; type: string }) => ({ agent_id: auth.agent_id, type: auth.type });

export const canonTools: ToolDef[] = [
  {
    name: "canon_create",
    risk: "write-low",
    description:
      "Make a rule canon (\"this is canon\"): one short rule Qoopia then loads into context by itself — " +
      "always, or on the turns its triggers and meaning point at — for you, a project or (steward/owner) the whole workspace. " +
      "Word the rule as an instruction. The server suggests triggers when you give none and replaces your older canon on the same rule; " +
      "a related but different canon returns CONFLICT with candidates: repeat with supersedes_id or on_conflict 'keep_both'.",
    rawSchema: {
      text: z.string().min(1).max(CANON_MAX_CHARS).describe("The rule itself, one rule, as short as it can be (aim for under 400 characters)."),
      scope: z.enum(CANON_SCOPES).optional().describe("agent (default for agents): only this agent; project: every agent in that project; workspace (steward/owner): every agent."),
      agent: z.string().min(1).max(128).optional().describe("Steward/owner: the agent id or name whose canon this is."),
      project: z.string().min(1).max(512).optional().describe("Project id or exact project name, for scope project."),
      mode: z.enum(CANON_MODES).optional().describe("contextual (default): loaded on matching turns; always: every session."),
      triggers: triggers.optional(),
      supersedes_id: z.string().min(1).max(128).optional().describe("Replace this canon; the old version stays in its history."),
      on_conflict: z.enum(["ask", "replace", "keep_both"]).optional(),
    },
    handler: (args, auth) => createCanon({
      workspace_id: auth.workspace_id, actor: actor(auth), text: args.text as string, scope: args.scope as never, agent: args.agent as string | undefined,
      project: args.project as string | undefined, mode: args.mode as never, triggers: args.triggers, supersedes_id: args.supersedes_id as string | undefined,
      on_conflict: args.on_conflict as never,
    }),
  },
  {
    name: "canon_update",
    risk: "write-low",
    description: "Change a canon. New text becomes a new version that supersedes it (history kept); mode and triggers change in place.",
    rawSchema: {
      id: z.string().min(1).max(128),
      text: z.string().min(1).max(CANON_MAX_CHARS).optional(),
      mode: z.enum(CANON_MODES).optional(),
      triggers: triggers.optional(),
    },
    handler: (args, auth) => updateCanon({ workspace_id: auth.workspace_id, actor: actor(auth), id: args.id as string, text: args.text as string | undefined, mode: args.mode as never, triggers: args.triggers }),
  },
  {
    name: "canon_retire",
    risk: "write-low",
    description: "Stop loading a canon. It stays readable in its history with the reason.",
    rawSchema: { id: z.string().min(1).max(128), reason: z.string().max(500).optional() },
    handler: (args, auth) => retireCanon({ workspace_id: auth.workspace_id, actor: actor(auth), id: args.id as string, reason: args.reason as string | undefined }),
  },
  {
    name: "canon_list",
    risk: "read",
    description: "Canons you can read: your own, your projects' and the workspace's (steward/owner: all). Filter by agent, scope, status or words.",
    rawSchema: {
      agent: z.string().min(1).max(128).optional(),
      scope: z.enum(CANON_SCOPES).optional(),
      status: z.enum(["active", "superseded", "retired", "all"]).optional(),
      query: z.string().min(1).max(500).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    handler: (args, auth) => listCanons({ workspace_id: auth.workspace_id, actor: actor(auth), agent: args.agent as string | undefined, scope: args.scope as never,
      status: args.status as never, query: args.query as string | undefined, limit: args.limit as number | undefined }),
  },
  {
    name: "canon_get",
    risk: "read",
    description: "One canon with its earlier versions and the latest turns it was loaded into.",
    rawSchema: { id: z.string().min(1).max(128) },
    handler: (args, auth) => getCanon({ workspace_id: auth.workspace_id, actor: actor(auth), id: args.id as string }),
  },
  {
    name: "canon_match",
    risk: "read",
    description:
      "Which canons apply to this turn. Clients with Qoopia memory hooks get them automatically; without hooks (ChatGPT, Claude Web) " +
      "call it with the user's message when a new task starts, and follow the returned rules.",
    rawSchema: {
      prompt: z.string().min(1).max(8000).describe("The user's message or the task in your own words."),
      project: z.string().min(1).max(512).optional(),
      files: z.array(z.string().min(1).max(512)).max(20).optional(),
      tools: z.array(z.string().min(1).max(120)).max(20).optional(),
      include_always: z.boolean().optional().describe("Default true; false when brief already gave you the always canons this session."),
    },
    handler: async (args, auth) => {
      const match = await matchCanons({ workspace_id: auth.workspace_id, agent_id: auth.agent_id, prompt: args.prompt as string, project: args.project as string | undefined,
        files: args.files as string[] | undefined, tools: args.tools as string[] | undefined, include_always: args.include_always as boolean | undefined, surface: "match" });
      return { always: match.always, contextual: match.contextual, text: renderCanon(match) };
    },
  },
];
