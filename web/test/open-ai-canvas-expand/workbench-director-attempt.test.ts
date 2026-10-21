import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("director attempts release busy after composer edits, refresh durable handoffs and isolate newer attempts", () => {
    const result = spawnSync(process.execPath, [resolve(import.meta.dir, "workbench-director-attempt.runner.tsx")], { cwd: resolve(import.meta.dir, "../.."), encoding: "utf8", timeout: 20_000 });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("workbench-director-attempt: passed");
});
