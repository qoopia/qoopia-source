/**
 * Agent names: Latin or Cyrillic letters, one script per name, plus digits, spaces, "_" and "-";
 * 1–64 characters after NFC and trim. A single script keeps a Cyrillic "а" out of "aaron".
 */
export const AGENT_NAME_RE=/^(?=[\s\S]{1,64}$)(?:[A-Za-z0-9_\-\s]+|(?:(?=\p{Script=Cyrillic})\p{L}|[0-9_\-\s])+)$/u;
export const AGENT_NAME_HINT='Use 1–64 Latin or Cyrillic letters (one alphabet per name), digits, spaces, underscores or hyphens';
export const normalizeAgentName=(name:string)=>String(name).normalize('NFC').trim();
/** Case-insensitive identity. SQLite lower() folds ASCII only, so names are compared here, never in SQL. */
export const agentNameKey=(name:string)=>normalizeAgentName(name).toLowerCase();
export const sameAgentName=(a:string,b:string)=>agentNameKey(a)===agentNameKey(b);
/** Cyrillic letters drawn like Latin ones or digits, lowercase (the key is lowercased first). */
const LOOKALIKE:Record<string,string>={а:'a',в:'b',г:'r',е:'e',ё:'e',з:'3',к:'k',м:'m',н:'h',о:'o',п:'n',р:'p',с:'c',т:'t',у:'y',х:'x',ь:'b',
  і:'i',ї:'i',ј:'j',ѕ:'s',һ:'h',ү:'y',ӏ:'l',ԁ:'d',ԛ:'q',ԝ:'w',ѵ:'v'};
/** «Аaron» with a Cyrillic А and «aaron» share one skeleton: a new name must not collide with any. */
export const agentNameSkeleton=(name:string)=>Array.from(agentNameKey(name),c=>LOOKALIKE[c]??c).join('');
/** The rows another principal could be mistaken for under `name`: same key or same skeleton. */
export const lookalikeAgents=<T extends {name:string}>(rows:T[],name:string)=>{
  const skeleton=agentNameSkeleton(name);return rows.filter(row=>agentNameSkeleton(row.name)===skeleton);
};
