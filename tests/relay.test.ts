import { afterEach, describe, expect, it, vi } from "vitest";
import { runNotesRelay } from "../src/bridge/relay.js";

afterEach(() => vi.unstubAllGlobals());

function fixture(commitMutation: ReturnType<typeof vi.fn>) {
  const definition = { params: { id: "fixture" } };
  const environment = {};
  const modules = {
    CometRelay: { commitMutation },
    PolarisRelayEnvironment: { default: environment },
  };
  const loadModules = vi.fn((_names, callback) => callback(definition));
  vi.stubGlobal("window", {
    setTimeout, clearTimeout,
    require(name: keyof typeof modules | "Bootloader") {
      if (name === "Bootloader") return { loadModules };
      if (modules[name]) return modules[name];
      throw new Error("Module requires bootloading");
    },
  });
  return { definition, environment, loadModules };
}

const options = {
  operation: "usePolarisDeleteInboxTrayItemSubmitMutation",
  variables: { inbox_tray_item_id: "note1" },
  mutation: true,
  timeoutMs: 20,
};

describe("private Notes Relay adapter", () => {
  it("loads the current mutation definition and handles the observed null delete field", async () => {
    const data = { xdt_delete_inbox_tray_item: null };
    const commit = vi.fn((_env, request) => { request.onCompleted(data); return { dispose: vi.fn() }; });
    const { definition, environment, loadModules } = fixture(commit);
    await expect(runNotesRelay(options)).resolves.toEqual({ state: "ok", data });
    expect(loadModules).toHaveBeenCalledWith([options.operation + ".graphql"], expect.any(Function), "InstagramNotes");
    expect(commit).toHaveBeenCalledWith(environment, expect.objectContaining({ mutation: definition, variables: options.variables }));
  });

  it("reports a restriction without submitting again", async () => {
    const commit = vi.fn((_env, request) => { request.onError(new Error("checkpoint_required")); });
    fixture(commit);
    await expect(runNotesRelay(options)).resolves.toEqual({ state: "restricted" });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("disposes a timed out mutation and reports an unconfirmed attempt", async () => {
    const dispose = vi.fn();
    fixture(vi.fn(() => ({ dispose })));
    await expect(runNotesRelay(options)).resolves.toEqual({ state: "failed" });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
