// Workflow catalogue (plan 2026-10-19-20-04 §17): every installed client can be driven for the scenarios the phase
// claims, every supported workflow has executable steps, and every gap is declared with a reason instead of silently
// missing. The catalogue is data, so these are pure checks; running a workflow is the `workflow` CLI command.
import { describe, expect, test } from "bun:test";
import { allWorkflows, workflowById, workflowsFor } from "@accounts-proxy/scripts/recon/workflows/catalogue.ts";
import { dismissExpression, modelChoiceExpression } from "@accounts-proxy/scripts/recon/run.ts";
import { allClients } from "@accounts-proxy/scripts/recon/clients.ts";

const EXPECTED = ["bootstrap", "turn", "turn-tools", "multiturn", "abort", "error"] as const;

describe("workflow catalogue", () => {
  test("covers every installed client with the full scenario set", () => {
    const clients = allClients();
    const workflows = allWorkflows();
    expect(Object.keys(workflows).sort()).toEqual(Object.keys(clients).sort());
    for (const [id, entries] of Object.entries(workflows)) {
      expect(entries.map((entry) => entry.id)).toEqual([...EXPECTED]);
      for (const entry of entries) {
        expect(entry.client).toBe(id);
        expect(entry.title.length).toBeGreaterThan(0);
        expect(entry.purpose.length).toBeGreaterThan(0);
      }
    }
  });

  test("a supported workflow has steps; an unsupported one says why and runs nothing", () => {
    for (const entries of Object.values(allWorkflows())) {
      for (const entry of entries) {
        if (entry.unsupported === undefined) {
          expect(entry.steps.length).toBeGreaterThan(0);
        } else {
          expect(entry.unsupported.length).toBeGreaterThan(20);
          expect(entry.steps).toEqual([]);
        }
      }
    }
  });

  test("every exec step names the sandbox path of the client, never a host path", () => {
    const clients = allClients();
    const hostHomes = new Set(Object.values(clients).map((client) => client.binary.source));
    for (const [id, entries] of Object.entries(allWorkflows())) {
      const client = clients[id];
      expect(client).toBeDefined();
      for (const entry of entries) {
        for (const step of entry.steps) {
          if (step.action.kind !== "exec") continue;
          expect(hostHomes.has(step.action.argv[0]!)).toBe(false);
          expect(step.action.argv[0]).toBe(client!.binary.target);
        }
      }
    }
  });

  test("a gui-prompt is always preceded by a gui-launch in the same workflow", () => {
    for (const entries of Object.values(allWorkflows())) {
      for (const entry of entries) {
        let launched = false;
        for (const step of entry.steps) {
          if (step.action.kind === "gui-launch") launched = true;
          if (step.action.kind === "gui-prompt") expect(launched).toBe(true);
        }
      }
    }
  });

  test("--model names opencode's own model on every turn, but not on the unknown-model workflow; other clients refuse it", () => {
    const argv = (id: string, model?: string) =>
      workflowById("opencode", id, model === undefined ? {} : { model }).steps.map((step) => (step.action.kind === "exec" ? step.action.argv.slice(1) : []));
    expect(argv("turn", "opencode/m1")).toEqual([["run", "--standalone", "--model", "opencode/m1", "Reply with the single word: ok"]]);
    expect(argv("turn")).toEqual([["run", "--standalone", "Reply with the single word: ok"]]);
    expect(argv("multiturn", "opencode-go/m2").map((step) => step.slice(0, 4))).toEqual([
      ["run", "--standalone", "--model", "opencode-go/m2"],
      ["run", "--standalone", "--model", "opencode-go/m2"],
    ]);
    expect(argv("error", "opencode/m1")[0]).toEqual(["run", "--standalone", "--model", "recon/not-a-model", "Reply with the single word: ok"]);
    expect(() => workflowsFor("claude", { model: "x" })).toThrow(/take no --model/);
  });

  test("unknown client or workflow fails loudly", () => {
    expect(() => workflowsFor("not-a-client")).toThrow();
    expect(() => workflowById("claude", "not-a-workflow")).toThrow(/unknown workflow/);
  });

  test("a GUI turn clears the trust modal and the onboarding carousel before typing", () => {
    // Measured on Antigravity 1.107.0: both dialogs cover the chat panel on every start, and the chat input does not
    // exist until the carousel is skipped. A turn workflow that skips this step captures nothing.
    const turn = workflowById("antigravity", "turn");
    const kinds = turn.steps.map((step) => step.action.kind);
    expect(kinds).toContain("gui-dismiss");
    expect(kinds.indexOf("gui-dismiss")).toBeLessThan(kinds.indexOf("gui-prompt"));
    expect(turn.expects).toBe(String.raw`:streamGenerateContent\b`);
    expect(modelChoiceExpression()).toContain(`closest('[role="menubar"]') === null`);
    const expression = dismissExpression();
    expect(expression).toContain("I trust the authors");
    expect(expression).toContain("Skip onboarding");
    // Past the first slide only "Next" leads on, and only while the chat input is still absent.
    expect(expression).toContain("clickBy(/^Next\\b/i)");
    expect(expression).toContain(`'[aria-label="Message input"]'`);
    expect(expression).toContain("click()");
  });

  test("every Codex turn workflow names the codex/responses WebSocket, and a resumed session skips the git check", () => {
    // Measured on codex-cli 0.163.0 (runs 2026-10-25-02-03-*): each turn opens `GET /backend-api/codex/responses`;
    // `exec resume` outside a git repository refuses to start without --skip-git-repo-check.
    for (const id of ["turn", "turn-tools", "multiturn", "abort", "error"]) {
      expect(workflowById("codex", id).expects).toBe(String.raw`/backend-api/codex/responses\b`);
    }
    expect(new RegExp(workflowById("codex", "turn").expects ?? "").test("https://chatgpt.com/backend-api/codex/responses")).toBe(true);
    expect(new RegExp(workflowById("codex", "turn").expects ?? "").test("https://chatgpt.com/backend-api/codex/analytics-events/events")).toBe(false);
    const resume = workflowById("codex", "multiturn").steps[1]?.action;
    expect(resume?.kind === "exec" ? resume.argv : []).toContain("--skip-git-repo-check");
    expect(workflowById("codex", "bootstrap").unsupported).toContain("0 flows");
  });
});
