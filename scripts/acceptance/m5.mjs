// M5 (API part): renaming locks the name; a duplicate name is rejected; blocked names are refused.
import { Client, assert, log } from "./client.mjs";

const c = new Client();
await c.signup();
const created = [];

try {
  const a = await c.req("POST", "/agents", { name: "Waffle" });
  assert(a.status === 201, `create: ${a.status} ${a.text}`);
  created.push(a.json.id);

  const dup = await c.req("POST", "/agents", { name: "waffle" });
  assert(dup.status === 409, `duplicate name accepted (${dup.status})`);
  log(`duplicate name rejected: "${dup.json.message}"`);

  const blocked = await c.req("POST", "/agents", { name: "Pikachu" });
  assert(blocked.status === 422, `blocked name accepted (${blocked.status})`);
  log(`blocked name refused: "${blocked.json.message}"`);

  const hatched = await c.req("POST", "/hatch", {
    goal: "Keep my notes tidy",
    personality: {},
    avatar: { base: "ghost", color: "lilac" },
    name: "Sprout",
    nameChosenBy: "agent",
  });
  assert(hatched.status === 201 && hatched.json.agent.nameLocked === false, `hatch: ${hatched.status} ${hatched.text}`);
  const id = hatched.json.agent.id;
  created.push(id);
  await c.req("POST", `/tasks/${hatched.json.firstTaskId}/cancel`);

  const renamed = await c.req("PATCH", `/agents/${id}`, { name: "Clover" });
  assert(renamed.status === 200 && renamed.json.name === "Clover" && renamed.json.nameLocked === true, `rename: ${renamed.text}`);
  log("renaming set the new name and locked it");

  const clash = await c.req("PATCH", `/agents/${id}`, { name: "Waffle" });
  assert(clash.status === 409, "renaming onto another agent's name was accepted");
  log("renaming onto a taken name is rejected");
} finally {
  for (const id of created) await c.req("DELETE", `/agents/${id}`);
}
