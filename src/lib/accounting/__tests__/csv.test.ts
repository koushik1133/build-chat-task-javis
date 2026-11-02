import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: vi.fn(),
  withRetry: (fn: () => unknown) => fn(),
}));

import { csvField, csvProvider, isFormulaLike, minorToMajor, parseCsv, toCsv, INVOICE_HEADERS } from "@/lib/accounting/csv";
import { activeAccountingProviderId, AccountingNotConfiguredError, getAccountingProvider } from "@/lib/accounting";

describe("csvField (RFC 4180)", () => {
  it("leaves plain values untouched", () => {
    expect(csvField("hello")).toBe("hello");
    expect(csvField(12.5)).toBe("12.5");
    expect(csvField(true)).toBe("true");
  });
  it("renders null/undefined as empty", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });
  it("quotes fields containing commas, quotes, CR or LF and doubles quotes", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
  it("neutralises spreadsheet formula injection in text cells", () => {
    expect(csvField('=HYPERLINK("https://evil.example","click")')).toBe('"\'=HYPERLINK(""https://evil.example"",""click"")"');
    expect(csvField("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(csvField("@SUM(1+1)")).toBe("'@SUM(1+1)");
    expect(csvField("-foo")).toBe("'-foo");
    expect(csvField("\t=1")).toBe("'\t=1");
  });
  it("leaves plain and negative numbers unquoted so accounting imports still read them as numbers", () => {
    expect(csvField("-2.50")).toBe("-2.50");
    expect(csvField(-250)).toBe("-250");
    expect(csvField("0.00")).toBe("0.00");
    expect(isFormulaLike("-12")).toBe(false);
    expect(isFormulaLike("-12abc")).toBe(true);
    expect(isFormulaLike("=1")).toBe(true);
  });
  it("guards every text column of a real export row", async () => {
    query.mockReset();
    query.mockResolvedValue([
      {
        number: "INV-000002", created_at: "2026-01-05T10:00:00.000Z", due_at: null, status: "sent", currency: "USD",
        subtotal_minor: "-5000", tax_minor: "0", total_minor: "-5000", paid_minor: "0", notes: "=cmd|'/C calc'!A0",
        customer: "+Acme", customer_email: "@ap@acme.test", quote_number: null,
      },
    ]);
    const file = await csvProvider.exportInvoices("owner-1", {});
    const parsed = parseCsv(file.body);
    const row = Object.fromEntries(INVOICE_HEADERS.map((h, i) => [h, parsed[1][i]]));
    expect(row.Notes).toBe("'=cmd|'/C calc'!A0");
    expect(row.Customer).toBe("'+Acme");
    expect(row.CustomerEmail).toBe("'@ap@acme.test");
    expect(row.Subtotal).toBe("-50.00");
    expect(row.Balance).toBe("-50.00");
  });
});

describe("toCsv", () => {
  it("writes a header, CRLF record terminators and a trailing CRLF", () => {
    const out = toCsv(["A", "B"], [["1", "x,y"], [2, null]]);
    expect(out).toBe('A,B\r\n1,"x,y"\r\n2,\r\n');
  });
  it("round-trips through parseCsv", () => {
    const rows = [["Acme, Inc.", 'He said "no"', "multi\nline"], ["", "0.00", "plain"]];
    const parsed = parseCsv(toCsv(["Name", "Quote", "Note"], rows));
    expect(parsed).toEqual([["Name", "Quote", "Note"], ...rows]);
  });
  it("handles an empty row set", () => {
    expect(toCsv(["Only"], [])).toBe("Only\r\n");
  });
});

describe("minorToMajor", () => {
  it("formats minor units with two decimals", () => {
    expect(minorToMajor(123456)).toBe("1234.56");
    expect(minorToMajor("5")).toBe("0.05");
    expect(minorToMajor(null)).toBe("0.00");
    expect(minorToMajor(-250)).toBe("-2.50");
  });
});

describe("csvProvider.exportInvoices", () => {
  beforeEach(() => query.mockReset());

  it("scopes to the org, applies the range and renders money in major units", async () => {
    query.mockResolvedValue([
      {
        number: "INV-000001", created_at: "2026-01-05T10:00:00.000Z", due_at: "2026-01-19T00:00:00.000Z", status: "paid", currency: "USD",
        subtotal_minor: "10000", tax_minor: "1000", total_minor: "11000", paid_minor: "11000", notes: "Thanks, see you soon",
        customer: "Acme, Inc.", customer_email: "ap@acme.test", quote_number: "Q-000001",
      },
    ]);
    const file = await csvProvider.exportInvoices("owner-1", { from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T23:59:59.000Z" });
    expect(file.rows).toBe(1);
    expect(file.filename).toBe("invoices_2026-01-01_2026-01-31.csv");
    expect(file.contentType).toContain("text/csv");
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain("i.user_id = $1");
    expect(String(sql)).toContain("i.created_at >= $2");
    expect(String(sql)).toContain("i.created_at <= $3");
    expect(params).toEqual(["owner-1", "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.000Z"]);

    const parsed = parseCsv(file.body);
    expect(parsed[0]).toEqual([...INVOICE_HEADERS]);
    const row = Object.fromEntries(INVOICE_HEADERS.map((h, i) => [h, parsed[1][i]]));
    expect(row.InvoiceNumber).toBe("INV-000001");
    expect(row.InvoiceDate).toBe("2026-01-05");
    expect(row.Customer).toBe("Acme, Inc.");
    expect(row.Subtotal).toBe("100.00");
    expect(row.Tax).toBe("10.00");
    expect(row.Total).toBe("110.00");
    expect(row.Balance).toBe("0.00");
    expect(row.Notes).toBe("Thanks, see you soon");
  });

  it("omits range clauses when no range is given", async () => {
    query.mockResolvedValue([]);
    const file = await csvProvider.exportExpenses("owner-1", {});
    expect(file.rows).toBe(0);
    expect(file.filename).toBe("expenses_all_now.csv");
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).not.toContain(">= $2");
    expect(params).toEqual(["owner-1"]);
  });
});

describe("provider registry", () => {
  it("defaults to csv and honours ACCOUNTING_PROVIDER", () => {
    const prev = process.env.ACCOUNTING_PROVIDER;
    delete process.env.ACCOUNTING_PROVIDER;
    expect(activeAccountingProviderId()).toBe("csv");
    expect(getAccountingProvider().name).toBe("csv");
    process.env.ACCOUNTING_PROVIDER = "xero";
    expect(activeAccountingProviderId()).toBe("xero");
    process.env.ACCOUNTING_PROVIDER = "bogus";
    expect(activeAccountingProviderId()).toBe("csv");
    if (prev === undefined) delete process.env.ACCOUNTING_PROVIDER;
    else process.env.ACCOUNTING_PROVIDER = prev;
  });

  it("quickbooks/xero stubs throw not configured", async () => {
    const qb = getAccountingProvider("quickbooks");
    expect(qb.configured()).toBe(false);
    await expect(qb.exportPayments("owner-1", {})).rejects.toBeInstanceOf(AccountingNotConfiguredError);
    await expect(getAccountingProvider("xero").exportInvoices("owner-1", {})).rejects.toThrow(/not configured/);
  });
});
