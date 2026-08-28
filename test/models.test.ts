import { describe, it, expect } from "vitest";
import {
  resolveRegion,
  getCachedModels,
  findModel,
  staticGlobalModels,
  staticCnModels,
  fetchModelCatalog,
} from "../src/models.js";

describe("resolveRegion", () => {
  it("默认 global", () => {
    expect(resolveRegion()).toBe("global");
    expect(resolveRegion(undefined)).toBe("global");
    expect(resolveRegion("global")).toBe("global");
  });

  it("显式 override 识别 CN 别名", () => {
    expect(resolveRegion("cn")).toBe("cn");
    expect(resolveRegion("CN")).toBe("cn");
    expect(resolveRegion("china")).toBe("cn");
    expect(resolveRegion("qodercn")).toBe("cn");
    expect(resolveRegion("qoder-cn")).toBe("cn");
  });

  it("未知值回退 global", () => {
    expect(resolveRegion("mars")).toBe("global");
  });

  it("环境变量 QODER_REGION 生效且 override 优先", () => {
    const prev = process.env.QODER_REGION;
    try {
      process.env.QODER_REGION = "cn";
      expect(resolveRegion()).toBe("cn");
      expect(resolveRegion("global")).toBe("global");
    } finally {
      if (prev === undefined) delete process.env.QODER_REGION;
      else process.env.QODER_REGION = prev;
    }
  });
});

describe("静态模型表（input 声明不变量）", () => {
  it("Global 与 CN 表均非空", () => {
    expect(staticGlobalModels.length).toBeGreaterThan(0);
    expect(staticCnModels.length).toBeGreaterThan(0);
  });

  it("global auto 声明 image 输入（已实测透传），其余保持 text-only", () => {
    for (const m of staticGlobalModels) {
      expect(m.input).toEqual(m.id === "auto" ? ["text", "image"] : ["text"]);
    }
    // CN 区域链路未实测图片透传，保守声明
    for (const m of staticCnModels) {
      expect(m.input).toEqual(["text"]);
    }
  });

  it("每个模型必备字段齐全且 id 唯一", () => {
    for (const models of [staticGlobalModels, staticCnModels]) {
      const ids = new Set<string>();
      for (const m of models) {
        expect(typeof m.id).toBe("string");
        expect(typeof m.name).toBe("string");
        expect(typeof m.sdkModelId).toBe("string");
        expect(typeof m.contextWindow).toBe("number");
        expect(typeof m.maxTokens).toBe("number");
        ids.add(m.id);
      }
      expect(ids.size).toBe(models.length);
    }
  });

  it("两个区域都包含 auto 模型", () => {
    expect(staticGlobalModels.some((m) => m.id === "auto")).toBe(true);
    expect(staticCnModels.some((m) => m.id === "auto")).toBe(true);
  });

  it("静态兜底仅保留官方路由模型（第三方模型以动态目录为准）", () => {
    expect(staticGlobalModels.map((m) => m.id).sort()).toEqual([
      "auto",
      "efficient",
      "lite",
      "performance",
      "ultimate",
    ]);
    expect(staticCnModels.map((m) => m.id)).toEqual(["auto"]);
  });
});

describe("缓存读取与查找", () => {
  it("getCachedModels 返回数组（缓存或静态 fallback）", () => {
    for (const region of ["global", "cn"] as const) {
      const models = getCachedModels(region);
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === "auto")).toBe(true);
    }
  });

  it("findModel 命中与未命中", () => {
    expect(findModel("auto", "global")?.sdkModelId).toBe("auto");
    expect(findModel("nonexistent-xyz", "global")).toBeUndefined();
  });
});

describe("fetchModelCatalog 门禁", () => {
  it("是可调用的 async 函数（结构冒烟）", () => {
    expect(typeof fetchModelCatalog).toBe("function");
  });
  // 远端行为（exchange/userinfo/model list）需要真实凭据，由 test-bridge.mjs 覆盖；
  // 缓存新鲜时短路返回缓存的逻辑依赖文件系统状态，不在无副作用单测范围内断言。
});
