import { query, queryOne } from "@/lib/dsql";
import { BOOKING_COLS, BOOKING_TYPE_COLS, type BookingRow, type BookingTypeRow } from "@/lib/calendar/booking";
import { issueShareToken } from "@/lib/share-tokens";
import { contactBalances, type StatementBalance } from "@/lib/money/statements";
import { bookingChangeWindowHours } from "@/lib/calendar/booking";
import { withinChangeWindow, toPortalProject, type PortalOrder, type PortalProject, type PortalDocumentItem } from "@/lib/portal-rules";
import { unreadForContact } from "@/lib/portal-messages";
import { getOrder, issueOrderLink } from "@/lib/storefront/orders";
import { listProjects, listMilestones } from "@/lib/projects/store";
import { projectProgress } from "@/lib/projects/progress";
import { listDocuments } from "@/lib/documents/documents";

/**
 * Client portal read model. Only whitelisted fields leave this module so a
 * portal token can never leak internal notes, deal values or other contacts.
 *
 * Quotes/invoices come from Lane C's tables; each query is wrapped so the
 * portal still renders when those tables do not exist yet.
 */

export interface PortalContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
}

export interface PortalQuote {
  id: string;
  number: string;
  status: string;
  currency: string;
  totalMinor: number;
  validUntil: string | null;
  createdAt: string;
  /** Public quote page, when a share token could be issued. */
  path: string | null;
}

export interface PortalInvoice {
  id: string;
  number: string;
  status: string;
  currency: string;
  totalMinor: number;
  paidMinor: number;
  dueAt: string | null;
  createdAt: string;
  path: string | null;
  /** Unpaid and not void: the invoice page at `path` offers "Pay now". */
  payable: boolean;
  outstandingMinor: number;
}

export interface PortalBooking {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  status: string;
  typeName: string | null;
  /** Customer may still reschedule/cancel (outside the org's change window). */
  canChange: boolean;
  /** Booking type id, so the portal can fetch slots for the same type. */
  hasType: boolean;
}

export interface PortalCard {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
}

export interface PortalData {
  org: { name: string; slug: string };
  contact: PortalContact;
  quotes: PortalQuote[];
  invoices: PortalInvoice[];
  bookings: PortalBooking[];
  cards: PortalCard[];
  /** Public booking path for the org's first active booking type. */
  bookPath: string | null;
  timezone: string;
  /** Outstanding balance in the contact's main currency (positive = owed), plus every currency. */
  balance_minor: number;
  balance_currency: string | null;
  balances: StatementBalance[];
  /** Portal v2 */
  orders: PortalOrder[];
  projects: PortalProject[];
  /** Confirmed future bookings with reschedule/cancel affordances. */
  upcomingBookings: PortalBooking[];
  changeWindowHours: number;
  /** Documents awaiting this contact's signature. */
  documents: PortalDocumentItem[];
  unreadMessages: number;
  statement: { balances: StatementBalance[]; hasStatement: boolean };
}

interface Options {
  /** Issue short-lived share links for quotes/invoices (public portal view). */
  issueLinks?: boolean;
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn("[portal] section unavailable:", err instanceof Error ? err.message : err);
    return fallback;
  }
}

export async function getPortalData(dataId: string, contactId: string, opts: Options = {}): Promise<PortalData | null> {
  const contact = await queryOne<{ id: string; full_name: string; email: string | null; phone: string | null; company: string | null }>(
    `SELECT id, full_name, email, phone, company FROM crm_contacts WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [dataId, contactId]
  ).catch(() =>
    queryOne<{ id: string; full_name: string; email: string | null; phone: string | null; company: string | null }>(
      `SELECT id, full_name, email, phone, company FROM crm_contacts WHERE user_id = $1 AND id = $2`,
      [dataId, contactId]
    )
  );
  if (!contact) return null;

  const org = (await queryOne<{ name: string; slug: string }>(`SELECT name, slug FROM organizations WHERE owner_user_id = $1`, [dataId])) ?? {
    name: "Client portal",
    slug: "",
  };

  const windowHours = await bookingChangeWindowHours(dataId).catch(() => 24);
  const [quotes, invoices, bookings, cards, firstType, cal, balances, orders, projects, documents, unreadMessages] = await Promise.all([
    safe(async () => {
      const rows = await query<{ id: string; number: string; status: string; currency: string; total_minor: string | number; valid_until: string | null; created_at: string }>(
        `SELECT id, number, status, currency, total_minor, valid_until, created_at FROM quotes
          WHERE user_id = $1 AND contact_id = $2 AND status <> 'draft' ORDER BY created_at DESC LIMIT 50`,
        [dataId, contactId]
      );
      return Promise.all(
        rows.map(async (q): Promise<PortalQuote> => {
          let path: string | null = null;
          if (opts.issueLinks) {
            try {
              path = (await issueShareToken(dataId, "quote", q.id, 14)).path;
            } catch {
              path = null;
            }
          }
          return { id: q.id, number: q.number, status: q.status, currency: q.currency, totalMinor: Number(q.total_minor), validUntil: q.valid_until, createdAt: q.created_at, path };
        })
      );
    }, [] as PortalQuote[]),
    safe(async () => {
      const rows = await query<{ id: string; number: string; status: string; currency: string; total_minor: string | number; paid_minor: string | number; due_at: string | null; created_at: string }>(
        `SELECT id, number, status, currency, total_minor, paid_minor, due_at, created_at FROM invoices
          WHERE user_id = $1 AND contact_id = $2 AND status <> 'draft' ORDER BY created_at DESC LIMIT 50`,
        [dataId, contactId]
      );
      return Promise.all(
        rows.map(async (i): Promise<PortalInvoice> => {
          let path: string | null = null;
          if (opts.issueLinks) {
            try {
              path = (await issueShareToken(dataId, "invoice", i.id, 14)).path;
            } catch {
              path = null;
            }
          }
          return { id: i.id, number: i.number, status: i.status, currency: i.currency, totalMinor: Number(i.total_minor), paidMinor: Number(i.paid_minor), dueAt: i.due_at, createdAt: i.created_at, path, payable: i.status !== "paid" && i.status !== "void" && Number(i.total_minor) - Number(i.paid_minor) > 0, outstandingMinor: Math.max(Number(i.total_minor) - Number(i.paid_minor), 0) };
        })
      );
    }, [] as PortalInvoice[]),
    safe(async () => {
      const rows = await query<BookingRow & { type_name: string | null }>(
        `SELECT ${BOOKING_COLS.split(", ").map((c) => `b.${c}`).join(", ")}, t.name AS type_name
           FROM bookings b LEFT JOIN booking_types t ON t.id = b.booking_type_id
          WHERE b.user_id = $1 AND b.contact_id = $2 AND b.ends_at > NOW() - INTERVAL '1 day'
          ORDER BY b.starts_at ASC LIMIT 50`,
        [dataId, contactId]
      );
      return rows.map((b): PortalBooking => ({ id: b.id, name: b.name, startsAt: b.starts_at, endsAt: b.ends_at, status: b.status, typeName: b.type_name, canChange: b.status === "confirmed" && withinChangeWindow(b.starts_at, windowHours), hasType: Boolean(b.booking_type_id) }));
    }, [] as PortalBooking[]),
    safe(async () => {
      // Production cards link to a contact via a `contact:<id>` tag or the contact's email as assignee.
      const rows = await query<{ id: string; title: string; status: string; due_date: string | null }>(
        `SELECT id::text AS id, title, status, due_date::text AS due_date FROM production_tasks
          WHERE user_id = $1 AND deleted_at IS NULL AND (tags LIKE $2 OR ($3::text IS NOT NULL AND assignee = $3))
          ORDER BY created_at DESC LIMIT 50`,
        [dataId, `%"contact:${contactId}"%`, contact.email]
      );
      return rows.map((c): PortalCard => ({ id: c.id, title: c.title, status: c.status, dueDate: c.due_date }));
    }, [] as PortalCard[]),
    safe(
      () =>
        queryOne<BookingTypeRow>(`SELECT ${BOOKING_TYPE_COLS} FROM booking_types WHERE user_id = $1 AND active = TRUE ORDER BY created_at ASC LIMIT 1`, [dataId]),
      null
    ),
    safe(() => queryOne<{ timezone: string }>(`SELECT timezone FROM calendars WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`, [dataId]), null),
    safe(() => contactBalances(dataId, contactId), [] as StatementBalance[]),
    safe(async () => {
      const ids = await query<{ id: string }>(
        `SELECT id FROM orders WHERE user_id = $1 AND (contact_id = $2 OR ($3::text IS NOT NULL AND lower(customer_email) = $3)) ORDER BY created_at DESC LIMIT 50`,
        [dataId, contactId, contact.email?.toLowerCase() ?? null]
      );
      const mine = (await Promise.all(ids.map((r) => getOrder(dataId, r.id)))).filter((o): o is NonNullable<typeof o> => Boolean(o));
      return Promise.all(
        mine.map(async (o): Promise<PortalOrder> => {
          let path: string | null = null;
          if (opts.issueLinks) path = await issueOrderLink(dataId, o, 30).then((l) => l.path).catch(() => null);
          return { id: o.id, number: o.number, status: o.status, currency: o.currency, totalMinor: o.total_minor, createdAt: String(o.created_at), path };
        })
      );
    }, [] as PortalOrder[]),
    safe(async () => {
      const rows = (await listProjects(dataId, { limit: 100 })).filter((p) => p.contact_id === contactId && p.status !== "cancelled").slice(0, 20);
      return Promise.all(
        rows.map(async (p) => {
          const [prog, ms] = await Promise.all([projectProgress(dataId, p.id), listMilestones(dataId, p.id)]);
          return toPortalProject(p, prog, ms);
        })
      );
    }, [] as PortalProject[]),
    safe(async () => {
      const docs = await listDocuments(dataId, { contactId, limit: 50 });
      const email = contact.email?.toLowerCase() ?? null;
      const out: PortalDocumentItem[] = [];
      for (const d of docs) {
        if (d.status !== "sent" && d.status !== "viewed") continue;
        const signer = email ? d.signers.find((s) => s.email.toLowerCase() === email && s.status !== "signed" && s.status !== "declined") : undefined;
        let signPath: string | null = null;
        if (signer && opts.issueLinks) signPath = await issueShareToken(dataId, "sign", signer.id, 14, { recipient: signer.email }).then((l) => l.path).catch(() => null);
        out.push({ id: d.id, title: d.title, status: d.status, signPath });
      }
      return out;
    }, [] as PortalDocumentItem[]),
    safe(() => unreadForContact(dataId, contactId), 0),
  ]);
  const main = [...balances].sort((a, b) => Math.abs(b.closing_minor) - Math.abs(a.closing_minor))[0] ?? null;

  return {
    org,
    contact: { id: contact.id, name: contact.full_name, email: contact.email, phone: contact.phone, company: contact.company },
    quotes,
    invoices,
    bookings,
    cards,
    bookPath: firstType && org.slug ? `/book/${org.slug}/${firstType.slug}` : null,
    timezone: cal?.timezone ?? "UTC",
    balance_minor: main?.closing_minor ?? 0,
    balance_currency: main?.currency ?? null,
    balances,
    orders,
    projects,
    upcomingBookings: bookings.filter((b) => b.status === "confirmed" && new Date(b.endsAt).getTime() > Date.now()),
    changeWindowHours: windowHours,
    documents,
    unreadMessages,
    statement: { balances, hasStatement: balances.length > 0 },
  };
}
