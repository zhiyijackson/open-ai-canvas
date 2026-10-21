import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("real native Agent controller waits for skills, freezes the first request and persists before POST", () => {
    // Module mocks stay in a child process so other host API/store regressions keep their real modules.
    const result = spawnSync(process.execPath, [resolve(import.meta.dir, "native-agent-skill-prefill.runner.tsx")], { cwd: resolve(import.meta.dir, "../.."), encoding: "utf8", timeout: 20_000 });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("native-agent-skill-prefill: passed");
});
