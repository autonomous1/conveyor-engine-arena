import { boot } from "./boot.js";
import { startSolo } from "./solo.js";

const solo = await startSolo();
await boot(solo.view, solo.open, { auth: false });
