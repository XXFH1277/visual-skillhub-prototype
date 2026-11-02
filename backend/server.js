import { createWorkspace } from "./app.js";
const workspace = await createWorkspace();
const port = Number(process.env.PORT) || 8787;
const server = workspace.app.listen(port, "127.0.0.1", () => {
  console.log(`SkillHub: http://localhost:${port}`);
  console.log(`本机访问码文件（请勿公开）：${workspace.secretFile}`);
});
server.requestTimeout = 60_000;
server.headersTimeout = 15_000;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await workspace.close();
  server.closeAllConnections();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
