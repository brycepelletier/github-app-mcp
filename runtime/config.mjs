import fs from "node:fs";
import path from "node:path";

const REQUIRED_VARIABLES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY_PATH",
];

export function requiredConfiguration(environment = process.env) {
  for (const name of REQUIRED_VARIABLES) {
    if (typeof environment[name] !== "string" || !environment[name]) {
      throw new Error(`${name} is required.`);
    }
  }

  const appId = environment.GITHUB_APP_ID;
  const installationId = environment.GITHUB_APP_INSTALLATION_ID;
  const pemPath = environment.GITHUB_APP_PRIVATE_KEY_PATH;

  if (!/^[1-9]\d*$/.test(appId)) {
    throw new Error("GITHUB_APP_ID must be a positive integer.");
  }
  if (!/^[1-9]\d*$/.test(installationId)) {
    throw new Error("GITHUB_APP_INSTALLATION_ID must be a positive integer.");
  }

  let resolvedPemPath;
  try {
    resolvedPemPath = fs.realpathSync.native(path.resolve(pemPath));
  } catch {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY_PATH must identify a readable regular file."
    );
  }

  if (!fs.statSync(resolvedPemPath).isFile()) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY_PATH must identify a readable regular file."
    );
  }

  return { appId, installationId, pemPath: resolvedPemPath };
}
