import { describe, it, expect } from "vitest";
import { createLinkedAbortController, REQUEST_TIMEOUT_MS } from "../src/model.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("REQUEST_TIMEOUT_MS", () => {
  it("默认 10 分钟（与 pi-qoder-provider 的 DEFAULT_TIMEOUT_MS 对齐）", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(10 * 60_000);
  });
});

describe("createLinkedAbortController", () => {
  it("宿主 abort 转发到内部 controller，reason 保留", () => {
    const host = new AbortController();
    const { controller, cleanup } = createLinkedAbortController(host.signal);

    expect(controller.signal.aborted).toBe(false);
    const reason = new Error("user cancelled");
    host.abort(reason);

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(reason);
    cleanup();
  });

  it("宿主 signal 已 aborted 时构造即 abort", () => {
    const host = new AbortController();
    const reason = new Error("already aborted");
    host.abort(reason);

    const { controller, cleanup } = createLinkedAbortController(host.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(reason);
    cleanup();
  });

  it("超时触发 abort（AbortSignal.timeout 兜底）", async () => {
    const { controller, cleanup } = createLinkedAbortController(undefined, 30);
    expect(controller.signal.aborted).toBe(false);

    await sleep(120);

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(Error);
    expect((controller.signal.reason as Error).name).toBe("TimeoutError");
    cleanup();
  });

  it("cleanup 后宿主 abort 不再转发（正常结束的 query 不受迟到的宿主信号影响）", () => {
    const host = new AbortController();
    const { controller, cleanup } = createLinkedAbortController(host.signal, 0);

    cleanup();
    host.abort(new Error("late"));

    expect(controller.signal.aborted).toBe(false);
  });

  it("timeoutMs <= 0 时禁用超时兜底", () => {
    const { controller, cleanup } = createLinkedAbortController(undefined, 0);
    expect(controller.signal.aborted).toBe(false);
    cleanup();
  });

  it("无宿主 signal 且有超时时仍可超时 abort", async () => {
    const { controller, cleanup } = createLinkedAbortController(undefined, 30);
    await sleep(120);
    expect(controller.signal.aborted).toBe(true);
    cleanup();
  });
});
