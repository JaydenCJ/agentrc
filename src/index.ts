#!/usr/bin/env node
import { run } from "./cli.js";
import { AgentrcError } from "./core/errors.js";

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  if (err instanceof AgentrcError) {
    console.error(`agentrc: ${err.message}`);
    process.exitCode = err.exitCode;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
}
