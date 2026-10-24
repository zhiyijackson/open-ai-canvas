import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("skill installation ignores completion and failure after unmount but still works while mounted", () => {
    const result = spawnSync(process.execPath, [resolve(import.meta.dir, "workbench-skill-lifecycle.runner.tsx")], {
        cwd: resolve(import.meta.dir, "../.."), encoding: "utf8", timeout: 20_000,
    });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("workbench-skill-lifecycle: passed");
});
