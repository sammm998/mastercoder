import { afterEach, describe, expect, it } from "vitest";
import { createSandboxProvider } from "../src/factory.js";

const saved = process.env.SANDBOX_PROVIDER;
afterEach(() => {
  if (saved === undefined) delete process.env.SANDBOX_PROVIDER;
  else process.env.SANDBOX_PROVIDER = saved;
});

describe("createSandboxProvider", () => {
  it.each([
    ["docker", "docker", false],
    ["e2b", "e2b", false],
    ["daytona", "daytona", false],
    ["local", "local", true],
    ["mock", "mock", true],
  ])("SANDBOX_PROVIDER=%s", (value, name, isMock) => {
    process.env.SANDBOX_PROVIDER = value;
    const p = createSandboxProvider();
    expect(p.name).toBe(name);
    expect(p.isMock).toBe(isMock);
  });

  it("defaults to docker and rejects unknown values", () => {
    delete process.env.SANDBOX_PROVIDER;
    expect(createSandboxProvider().name).toBe("docker");
    process.env.SANDBOX_PROVIDER = "firecracker";
    expect(() => createSandboxProvider()).toThrow(/Unknown SANDBOX_PROVIDER/);
  });
});
