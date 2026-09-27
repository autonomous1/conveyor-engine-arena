import { runBench } from "./bench.js";

const entities = Number(process.argv[2] ?? 200);
const ticks = Number(process.argv[3] ?? 30);
const report = runBench({ entities, ticks });
console.log(JSON.stringify(report, null, 2));
