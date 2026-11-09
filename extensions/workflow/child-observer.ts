import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ChildOriginV1 = Readonly<{
  version: 1;
  producer: "workflow" | "pi-subagents";
  parentSessionId?: string;
  runId?: string;
  callId?: string;
  attemptId?: string;
}>;
export type ChildLease = { dispose(): Promise<void> };
export type AttachChild = (session: AgentSession, origin: ChildOriginV1) => Promise<ChildLease>;

// Only this callback exchange crosses the bus. The SDK session goes directly to attach.
export function discoverChildObserver(events: ExtensionAPI["events"]): AttachChild | undefined {
  let observer: AttachChild | undefined;
  let conflict = false;
  events?.emit("pi-monitor:workflow-observer:v1", {
    version: 1,
    register(attach: AttachChild) {
      if (typeof attach !== "function" || (observer && observer !== attach)) conflict = true;
      else observer = attach;
    },
  });
  // Pi catches event listener exceptions: reject outside the listener instead.
  if (conflict) throw new Error("Incompatible workflow child observers registered.");
  return observer;
}

export async function disposeChildLease(lease: ChildLease | undefined): Promise<void> {
  if (!lease) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      lease.dispose(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); }),
    ]);
  } catch {
    // Upload/drain errors must not discard an already delivered model result.
    console.error("Workflow child observer could not finish draining.");
  } finally {
    clearTimeout(timer);
  }
}
