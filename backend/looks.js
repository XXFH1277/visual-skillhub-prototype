import { LOOK_SEEDS } from "../shared/suite.js";

// Shared by the product suite and the standalone pages: random seeds that push each direction
// somewhere different, and a log of what other merchants were offered lately so the next
// proposal steers away from it.
export const pickSome = (list, n) => [...list].sort(() => Math.random() - 0.5).slice(0, n);
export const lookSeeds = (k = 3) =>
  Array.from({ length: k }, () =>
    pickSome(Object.entries(LOOK_SEEDS), 4)
      .map(([dim, options]) => `${dim}＝${pickSome(options, 1)[0]}`)
      .join("；"),
  );

export function lookLog(db) {
  db.exec("CREATE TABLE IF NOT EXISTS look_log (category TEXT NOT NULL, summary TEXT NOT NULL, suite_id TEXT NOT NULL, created_at TEXT NOT NULL)");
  return {
    // Same category first; with no category yet (the AI hasn't looked), the latest of all.
    avoid(category, n = 12) {
      const rows = category
        ? db.prepare("SELECT summary FROM look_log WHERE category=? ORDER BY created_at DESC LIMIT ?").all(category, n)
        : db.prepare("SELECT summary FROM look_log ORDER BY created_at DESC LIMIT ?").all(n);
      return rows.map((r) => r.summary);
    },
    add(category, looks, refId) {
      const add = db.prepare("INSERT INTO look_log(category,summary,suite_id,created_at) VALUES(?,?,?,?)");
      for (const l of looks) if (l?.conceptName) add.run(category || "", `${l.conceptName}：${l.story || ""}`.slice(0, 80), refId, new Date().toISOString());
      db.prepare("DELETE FROM look_log WHERE rowid NOT IN (SELECT rowid FROM look_log ORDER BY created_at DESC LIMIT 600)").run();
    },
  };
}
