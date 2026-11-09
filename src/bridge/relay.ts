interface RelayRequest {
  operation: string;
  variables: Record<string, unknown>;
  mutation: boolean;
  timeoutMs: number;
}

type RelayResult =
  | { state: "ok"; data: any }
  | { state: "unavailable" | "failed" | "restricted" };

/** Executed in the signed-in page. Keep the function independent of Node imports. */
export async function runNotesRelay({ operation, variables, mutation, timeoutMs }: RelayRequest): Promise<RelayResult> {
  const req = (window as unknown as { require: (name: string) => any }).require;
  let submitted = false;
  let timeout: number | undefined;
  let cancel: (() => void) | undefined;
  try {
    const loadModule = async (name: string) => {
      try {
        const module = req(name);
        if (module) return module;
      } catch {
        // Some inbox modules load on demand.
      }

      return new Promise<any>((resolve) => {
        req("Bootloader").loadModules([name], resolve, "InstagramNotes");
      });
    };

    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = window.setTimeout(() => reject(new Error("Relay request timed out")), timeoutMs);
    });
    const [relay, environment, definition] = await Promise.race([
      Promise.all([
        loadModule("CometRelay"),
        loadModule("PolarisRelayEnvironment"),
        loadModule(operation + ".graphql"),
      ]),
      deadline,
    ]);
    if (!relay || !environment || !definition) return { state: "unavailable" };

    const request = new Promise<any>((resolve, reject) => {
      const env = environment.default ?? environment;
      const node = definition.default ?? definition;
      if (mutation) {
        if (typeof relay.commitMutation !== "function") { reject(new Error("Relay mutation runtime unavailable")); return; }
        submitted = true;
        const disposable = relay.commitMutation(env, {
          mutation: node,
          variables,
          onCompleted(data: unknown, errors?: unknown[]) {
            if (errors?.length) reject(errors);
            else resolve(data);
          },
          onError: reject,
        });
        cancel = () => disposable?.dispose();
        return;
      }

      let latest: unknown;
      const subscription = relay.fetchQuery(env, node, variables, { fetchPolicy: "network-only" }).subscribe({
        next(data: unknown) { latest = data; },
        error: reject,
        complete() { resolve(latest); },
      });
      cancel = () => subscription?.unsubscribe();
    });

    return { state: "ok", data: await Promise.race([request, deadline]) };
  } catch (err) {
    const details = err instanceof Error ? err.message : JSON.stringify(err ?? "");
    if (/challenge|checkpoint|login.required|rate.limit|try again later|feedback_required|\b429\b/i.test(details)) {
      return { state: "restricted" };
    }
    return { state: submitted ? "failed" : "unavailable" };
  } finally {
    window.clearTimeout(timeout);
    cancel?.();
  }
}
