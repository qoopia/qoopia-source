import json, os, sqlite3, sys, collections
H = os.environ["QOOPIA_EVAL_DIR"] + "/harness"
s = json.load(open(H + "/score.json"))
g = {}
for line in open(H + "/golden.jsonl"):
    c = json.loads(line); g[c["id"]] = c
db = sqlite3.connect("file:" + os.environ["QOOPIA_EVAL_DIR"] + "/snap.db?mode=ro", uri=True)
def note(i):
    r = db.execute("SELECT type, subject_key, replace(replace(substr(text,1,110),char(10),' '),'|','/') , supersedes_id IS NOT NULL, valid_until IS NOT NULL OR invalidated_at IS NOT NULL FROM notes WHERE id=?", (i,)).fetchone()
    return r or ("?", None, "", 0, 0)
modes = ["hybrid", "deep", "deep_llm", "entity_pages"]
pc = s["per_case"]
# stale ids appearing anywhere in top10
for m in modes:
    n = sum(1 for cid, c in g.items() if c["stale_ids"] and any(x in c["stale_ids"] for x in pc[cid][m]["ids"]))
    print("stale-in-top10", m, n)
# type distribution of top1 on misses@1 per mode, and among all top-10
for m in modes:
    t1 = collections.Counter(); t10 = collections.Counter()
    for cid, c in g.items():
        ids = pc[cid][m]["ids"]
        for x in ids: t10[note(x)[0]] += 1
        if c["expected_ids"] and pc[cid][m]["rank"] != 0 and ids: t1[note(ids[0])[0]] += 1
    print("top1-on-miss", m, dict(t1.most_common()), "| top10 types", dict(t10.most_common(6)))
# expected without subject_key
exp = [x for c in g.values() for x in c["expected_ids"]]
nosk = [x for x in exp if not note(x)[1]]
print("expected ids", len(exp), "no subject_key", len(nosk))
# entity_pages: page ids? count ids not in notes
for m in modes:
    miss = sum(1 for cid in g for x in pc[cid][m]["ids"] if note(x)[0] == "?")
    print("non-note ids", m, miss)
print("----")
rows = []
for cid, c in g.items():
    if not c["expected_ids"]: continue
    rk = {m: pc[cid][m]["rank"] for m in modes}
    if rk["hybrid"] == 0 and rk["deep"] == 0: continue
    rows.append((cid, c, rk))
def sev(r):
    rk = r[2]; v = lambda x: 99 if x < 0 else x
    return -(v(rk["hybrid"]) + v(rk["deep"]))
rows.sort(key=sev)
for cid, c, rk in rows:
    print("##", cid, c["category"], c["caller_agent"][:20] if c.get("caller_agent") else "", "ranks", rk, "q:", c["query"][:100].replace("\n", " "))
    for x in c["expected_ids"]:
        t = note(x); print("  exp", x, t[0], "sk" if t[1] else "no-sk", t[2])
    for x in pc[cid]["hybrid"]["ids"][:3]:
        t = note(x); print("  hyb", x, t[0], "sk" if t[1] else "no-sk", "STALE" if x in c["stale_ids"] else "", t[2])
