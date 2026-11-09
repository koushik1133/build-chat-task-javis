import { beforeEach, describe, expect, it } from "vitest";
import { escapeLabelValue, incCounter, observe, recordRequest, renderPrometheus, resetMetrics } from "../registry";

describe("prometheus rendering", () => {
  beforeEach(() => resetMetrics());

  it("renders counters with HELP/TYPE and escapes label values", () => {
    incCounter("kh_test_total", "A test.\nsecond line", { path: 'a"b\\c\nd' }, 2);
    const out = renderPrometheus();
    expect(out).toContain("# HELP kh_test_total A test.\\nsecond line");
    expect(out).toContain("# TYPE kh_test_total counter");
    expect(out).toContain('kh_test_total{path="a\\"b\\\\c\\nd"} 2');
    expect(escapeLabelValue('"\\\n')).toBe('\\"\\\\\\n');
  });

  it("renders cumulative histogram buckets with +Inf, sum and count", () => {
    observe("kh_lat_ms", "lat", 7, { group: "api" }, [5, 10, 50]);
    observe("kh_lat_ms", "lat", 40, { group: "api" }, [5, 10, 50]);
    observe("kh_lat_ms", "lat", 900, { group: "api" }, [5, 10, 50]);
    const out = renderPrometheus();
    expect(out).toContain('kh_lat_ms_bucket{group="api",le="5"} 0');
    expect(out).toContain('kh_lat_ms_bucket{group="api",le="10"} 1');
    expect(out).toContain('kh_lat_ms_bucket{group="api",le="50"} 2');
    expect(out).toContain('kh_lat_ms_bucket{group="api",le="+Inf"} 3');
    expect(out).toContain('kh_lat_ms_sum{group="api"} 947');
    expect(out).toContain('kh_lat_ms_count{group="api"} 3');
  });

  it("groups requests by status class and renders gauges once per name", () => {
    recordRequest("api", 200, 5);
    recordRequest("api", 503, 5);
    const out = renderPrometheus([{ name: "kh_g", help: "g", value: 1, labels: { s: "a" } }, { name: "kh_g", help: "g", value: 2, labels: { s: "b" } }]);
    expect(out).toContain('kh_http_requests_total{group="api",status="2xx"} 1');
    expect(out).toContain('kh_http_requests_total{group="api",status="5xx"} 1');
    expect(out.match(/# TYPE kh_g gauge/g)).toHaveLength(1);
    expect(out.endsWith("\n")).toBe(true);
  });
});
