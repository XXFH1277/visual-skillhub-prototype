import { Store } from "./store.js";
import { ADMIN_ID } from "./users.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// npm run credits -- 500            → admin account
// npm run credits -- 500 138xxxx    → the merchant with that phone
const amount = Number(process.argv[2]);
if (!Number.isInteger(amount) || amount < 1 || amount > 10000)
  throw new Error("用法：npm run credits -- 500 [手机号]（1–10000）");
const dataDir = fileURLToPath(new URL("../.data/", import.meta.url));
fs.mkdirSync(dataDir, { recursive: true });
const store = new Store(dataDir + "workspace.sqlite");
try {
  const phone = process.argv[3];
  const user = phone ? store.db.prepare("SELECT id FROM users WHERE phone=?").get(phone) : { id: ADMIN_ID };
  if (!user) throw new Error("没有这个手机号的账号");
  const after = store.users.grant(user.id, amount, "命令行充值");
  console.log(`已给 ${after.name} 补充 ${amount} 积分，余额 ${after.balance}`);
} finally {
  store.close();
}
