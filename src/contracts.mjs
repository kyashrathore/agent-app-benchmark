import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { REPOSITORY_ROOT } from "./paths.mjs";

const FILES = {
  app: "app-v1.schema.json",
  comparison: "comparison-v1.schema.json",
  corpus: "corpus-v1.schema.json",
  driverMessage: "driver-message-v1.schema.json",
  opencodeEvent: "opencode-event-v1.schema.json",
  result: "result-v1.schema.json",
  scenario: "scenario-v1.schema.json",
};

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value) => Number.isFinite(Date.parse(value)) && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value),
});

const validators = Object.fromEntries(Object.entries(FILES).map(([kind, file]) => {
  const schema = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "schemas", file), "utf8"));
  return [kind, ajv.compile(schema)];
}));

export function assertContract(kind, value, label = kind) {
  const validate = validators[kind];
  if (!validate) throw new Error(`Unknown contract kind: ${kind}.`);
  if (validate(value)) return value;
  const details = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") ?? "unknown validation error";
  throw new Error(`${label} failed schema validation: ${details}`);
}

export function contractSchemas() {
  return Object.keys(validators).toSorted();
}
