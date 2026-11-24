// The switch lives in the resolver, so a probe never names a tree: this file
// asks for the canonical `../src/connection.ts` and lets the loader pick `src/`
// or `proto/` from BOT_CLIENT_TREE.
const tree = process.env.BOT_CLIENT_TREE === "proto" ? "proto" : "src";
const url = import.meta.resolve("../src/connection.ts");
const expected = `/packages/bot-client/${tree}/connection.ts`;
console.log(`tree=${tree} connection=${url}`);
if (!url.endsWith(expected)) {
  console.error(`expected ${expected}`);
  process.exit(1);
}
