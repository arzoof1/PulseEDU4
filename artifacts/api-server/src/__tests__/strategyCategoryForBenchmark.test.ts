// Pure unit tests for strategyCategoryForBenchmark.
//
// Locks in the Math strand-prefix handling added in task #33. The
// motivating bug: Florida's grade 6+ Math category
// "Geometric Reasoning, Data Analysis, and Probability" bundles GR.*
// and DP.* benchmarks under one label, so a category-text-only mapping
// silently labelled every DP code as "Math — Geometry & Measurement".

import { describe, expect, it } from "vitest";
import { strategyCategoryForBenchmark } from "../routes/mtssPlans.js";

describe("strategyCategoryForBenchmark — Math strand prefix", () => {
  const sharedGRDPCategory =
    "3. Geometric Reasoning, Data Analysis, and Probability";

  it("maps NSO codes to Numbers & Operations", () => {
    expect(
      strategyCategoryForBenchmark(
        "1. Number Sense and Operations",
        "MA.6.NSO.3.4",
      ),
    ).toBe("Math — Numbers & Operations");
  });

  it("maps AR codes to Algebraic Reasoning", () => {
    expect(
      strategyCategoryForBenchmark("2. Algebraic Reasoning", "MA.6.AR.1.3"),
    ).toBe("Math — Algebraic Reasoning");
  });

  it("maps GR codes under the combined category to Geometry & Measurement", () => {
    expect(
      strategyCategoryForBenchmark(sharedGRDPCategory, "MA.6.GR.1.1"),
    ).toBe("Math — Geometry & Measurement");
  });

  it("maps DP codes under the combined category to Data & Statistics (not Geometry)", () => {
    expect(
      strategyCategoryForBenchmark(sharedGRDPCategory, "MA.6.DP.1.4"),
    ).toBe("Math — Data & Statistics");
  });

  it("derives strand from code even when category is null", () => {
    expect(strategyCategoryForBenchmark(null, "MA.6.DP.1.1")).toBe(
      "Math — Data & Statistics",
    );
    expect(strategyCategoryForBenchmark(null, "MA.4.FR.2.1")).toBe(
      "Math — Fractions",
    );
    expect(strategyCategoryForBenchmark(null, "MA.K.M.1.1")).toBe(
      "Math — Measurement",
    );
  });

  it("leaves ELA mappings intact", () => {
    expect(
      strategyCategoryForBenchmark(
        "Reading Prose and Poetry",
        "ELA.6.R.3.1",
      ),
    ).toBe("Reading Comprehension");
    expect(strategyCategoryForBenchmark("Vocabulary", "ELA.6.V.1.3")).toBe(
      "Vocabulary",
    );
  });

  it("falls back to the raw category label when nothing matches", () => {
    expect(strategyCategoryForBenchmark("Some Custom Domain", "X.1.2.3")).toBe(
      "Some Custom Domain",
    );
  });

  it("falls back to subject-only label when category is null and code is unknown", () => {
    expect(strategyCategoryForBenchmark(null, "ELA.6.X.1")).toBe("Reading");
    expect(strategyCategoryForBenchmark(null, "ZZZ.1.1")).toBe("Academic");
  });
});
