import { describe, expect, it } from "vitest";
import { execa } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv";

import { readSchema } from "./_helpers.mjs";

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

function expectValid(schemaName, payload) {
  const schema = readSchema(schemaName);
  const validate = ajv.compile(schema);
  const ok = validate(payload);
  if (!ok) {
    throw new Error(`Schema validation failed (${schemaName}): ${ajv.errorsText(validate.errors)}`);
  }
}

describe("CLI JSON contract - account list", () => {
  it("outputs a single JSON object with success/accounts/count", async () => {
    const bin = path.join(import.meta.dirname, "..", "bin", "mail-use.js");
    const r = await execa("node", [bin, "account", "list", "--json"], {
      reject: false,
      env: {
        ...process.env,
        // Ensure deterministic empty config location for tests.
        MAILBOX_CONFIG_DIR: path.join(import.meta.dirname, ".tmp_config"),
        MAILBOX_DATA_DIR: path.join(import.meta.dirname, ".tmp_data"),
      },
    });

    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload).toHaveProperty("success");
    expect(typeof payload.success).toBe("boolean");
    expect(payload).toHaveProperty("accounts");
    expect(Array.isArray(payload.accounts)).toBe(true);
    expect(payload).toHaveProperty("count");
    expect(typeof payload.count).toBe("number");
    expectValid("account_list.schema.json", payload);
  });

  it("does not read default home auth when MAILBOX_CONFIG_DIR is set", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-cli-account-list-"));
    const homeConfig = path.join(tmp, "home", ".config", "mailbox");
    fs.mkdirSync(homeConfig, { recursive: true });
    fs.writeFileSync(
      path.join(homeConfig, "auth.json"),
      JSON.stringify({
        version: 1,
        accounts: {
          home_acc: {
            email: "home@example.com",
            password: "home",
            provider: "mock",
          },
        },
        default_account: "home_acc",
      }) + "\n",
      "utf8"
    );

    const bin = path.join(import.meta.dirname, "..", "bin", "mail-use.js");
    const r = await execa("node", [bin, "account", "list", "--json"], {
      reject: false,
      env: {
        ...process.env,
        HOME: path.join(tmp, "home"),
        MAILBOX_INTERNAL_TEST_MODE: "1",
        MAILBOX_CONFIG_DIR: path.join(tmp, "isolated-config"),
        MAILBOX_DATA_DIR: path.join(tmp, "isolated-data"),
      },
    });

    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(true);
    expect(payload.accounts).toEqual([]);
    expect(payload.count).toBe(0);
  });
});
