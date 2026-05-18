#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import path from "node:path";

const [, , modulePath, ...args] = process.argv;

if (!modulePath) {
  throw new Error("Missing oh-my-wechat entry module.");
}

process.argv = [process.argv[0], modulePath, ...args];
await import(pathToFileURL(path.resolve(modulePath)).href);
