import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/settings.js";
import { type Hermetic, hermeticDir } from "./helpers/boot-extension.js";

let env: Hermetic;
afterEach(() => env?.restore());
const keys = ["defaultAgentTimeoutSeconds", "defaultWorkflowTimeoutSeconds", "maxConcurrentTotal", "workflowConcurrency"] as const;
describe("finite execution settings", () => {
  it("loads positive deadline and concurrency overrides", () => {
    const settings = { defaultAgentTimeoutSeconds: 0.5, defaultWorkflowTimeoutSeconds: 86400, maxConcurrentTotal: 1024, workflowConcurrency: 1 };
    env = hermeticDir({ settings });
    expect(loadSettings(env.dir)).toEqual(settings);
  });
  it.each([0, -1, 86401, null, "unlimited", "10"])("ignores invalid configured values %s, retaining finite defaults", value => {
    env = hermeticDir({ settings: Object.fromEntries(keys.map(key => [key, value])) });
    expect(loadSettings(env.dir)).toEqual({});
  });
  it("rejects fractional and excessive execution concurrency", () => {
    env = hermeticDir({ settings: { maxConcurrentTotal: 1.5, workflowConcurrency: 1025 } });
    expect(loadSettings(env.dir)).toEqual({});
  });
});
