import { readFileSync, writeFileSync } from "node:fs";
const file = "prisma/schema.prisma";
let content = readFileSync(file, "utf-8");
const re = /updated_at(\s+DateTime\??\s+@default\(now\(\)\))\s+(@db\.Timestamp\w*\(\d+\))/g;
const matches = content.match(re);
content = content.replace(re, "updated_at$1 @updatedAt $2");
writeFileSync(file, content, "utf-8");
console.log("Replaced " + (matches?.length || 0) + " updated_at columns with @updatedAt");