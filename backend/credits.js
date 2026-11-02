import { Store } from "./store.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const amount = Number(process.argv[2]);
if (!Number.isInteger(amount) || amount < 1 || amount > 10000)
  throw new Error("用法：npm run credits -- 500（1–10000）");
const dataDir = fileURLToPath(new URL("../.data/", import.meta.url));
fs.mkdirSync(dataDir, { recursive: true });
const store = new Store(dataDir + "workspace.sqlite");
try {
  store.transaction(() => {
    store.db
      .prepare("UPDATE wallet SET balance=balance+? WHERE id=1")
      .run(amount);
    store.db
      .prepare("INSERT INTO ledger(kind,amount,created_at) VALUES(?,?,?)")
      .run("grant", amount, new Date().toISOString());
  });
  console.log(`已补充 ${amount} 测试积分，余额 ${store.account().balance}`);
} finally {
  store.close();
}
