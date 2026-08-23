import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { requiredConfiguration } from "../runtime/config.mjs";

const complete = {
  GITHUB_APP_ID: "4618233",
  GITHUB_APP_INSTALLATION_ID: "154276908",
  GITHUB_APP_PRIVATE_KEY_PATH: "unused.pem",
};

test("GitHub App identity and PEM path are all required", () => {
  for (const name of Object.keys(complete)) {
    const environment = { ...complete };
    delete environment[name];
    assert.throws(
      () => requiredConfiguration(environment),
      { message: `${name} is required.` }
    );
  }
});

test("GitHub App and installation IDs must be positive integers", () => {
  for (const name of ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID"]) {
    for (const value of ["0", "-1", "1.5", " 1", "1 ", "abc"]) {
      assert.throws(() =>
        requiredConfiguration({ ...complete, [name]: value })
      );
    }
  }
});

test("complete external configuration resolves the PEM without defaults", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "github-app-mcp-"));
  const pemPath = path.join(directory, "test.pem");
  fs.writeFileSync(pemPath, "test-only-placeholder", { mode: 0o600 });

  try {
    assert.deepEqual(
      requiredConfiguration({ ...complete, GITHUB_APP_PRIVATE_KEY_PATH: pemPath }),
      {
        appId: complete.GITHUB_APP_ID,
        installationId: complete.GITHUB_APP_INSTALLATION_ID,
        pemPath: fs.realpathSync.native(pemPath),
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
