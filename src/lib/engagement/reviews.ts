import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { getBranding } from "@/lib/branding";

/**
 * Testimonials: a staff member promotes a survey response to a quote that can
 * be shown publicly. A response is promotable only when the customer ticked
 * "OK to display my feedback publicly" (survey_responses.public); publishing is a
 * separate staff action so nothing appears without review.
 */

export interface TestimonialDTO {
  id: string;
  response_id: string;
  quote: string;
  author_name: string;
  rating: number | null;
  featured: boolean;
  published: boolean;
  created_at: string;
}
interface Row { id: string; response_id: string; quote: string; author_name: string; rating: number | null; featured: boolean; published: boolean; created_at: string | Date }
const COLS = "id, response_id, quote, author_name, rating, featured, published, created_at";
const toDTO = (r: Row): TestimonialDTO => ({ ...r, rating: r.rating === null ? null : Number(r.rating), created_at: new Date(r.created_at).toISOString() });

/** First name + last initial, so a public quote never exposes a full name. */
export function publicAuthorName(full: string | null | undefined): string {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A customer";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export class TestimonialError extends Error {
  constructor(public readonly code: "not_found" | "no_consent" | "no_comment", message: string) {
    super(message);
    this.name = "TestimonialError";
  }
}

export async function promoteResponse(dataId: string, responseId: string, opts: { quote?: string | null; publish?: boolean; featured?: boolean } = {}): Promise<TestimonialDTO> {
  const resp = await queryOne<{ id: string; score: number | null; comment: string | null; public: boolean; contact_name: string | null; kind: string }>(
    `SELECT r.id, r.score, r.comment, r.public, c.full_name AS contact_name, s.kind FROM survey_responses r JOIN surveys s ON s.id = r.survey_id AND s.user_id = r.user_id LEFT JOIN crm_contacts c ON c.id = r.contact_id AND c.user_id = r.user_id WHERE r.id = $1 AND r.user_id = $2`,
    [responseId, dataId]
  );
  if (!resp) throw new TestimonialError("not_found", "Response not found");
  if (!resp.public) throw new TestimonialError("no_consent", "The customer did not agree to display their feedback publicly");
  const quote = (opts.quote ?? resp.comment ?? "").trim().slice(0, 1000);
  if (!quote) throw new TestimonialError("no_comment", "This response has no comment to publish");
  const rating = resp.score === null ? null : resp.kind === "nps" ? Math.max(1, Math.min(5, Math.round(resp.score / 2))) : resp.score;
  const existing = await queryOne<{ id: string }>(`SELECT id FROM testimonials WHERE user_id = $1 AND response_id = $2`, [dataId, responseId]);
  if (existing) {
    await query(`UPDATE testimonials SET quote = $3, published = COALESCE($4, published), featured = COALESCE($5, featured) WHERE id = $1 AND user_id = $2`, [existing.id, dataId, quote, opts.publish ?? null, opts.featured ?? null]);
    return (await getTestimonial(dataId, existing.id)) as TestimonialDTO;
  }
  const id = randomUUID();
  await query(`INSERT INTO testimonials (id, user_id, response_id, quote, author_name, rating, featured, published) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, dataId, responseId, quote, publicAuthorName(resp.contact_name), rating, opts.featured ?? false, opts.publish ?? false]);
  return (await getTestimonial(dataId, id)) as TestimonialDTO;
}

export async function getTestimonial(dataId: string, id: string): Promise<TestimonialDTO | null> {
  const r = await queryOne<Row>(`SELECT ${COLS} FROM testimonials WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return r ? toDTO(r) : null;
}
export async function listTestimonials(dataId: string, opts: { publishedOnly?: boolean; limit?: number } = {}): Promise<TestimonialDTO[]> {
  const rows = await query<Row>(`SELECT ${COLS} FROM testimonials WHERE user_id = $1 ${opts.publishedOnly ? "AND published = TRUE" : ""} ORDER BY featured DESC, created_at DESC, id DESC LIMIT $2`, [dataId, Math.min(Math.max(opts.limit ?? 100, 1), 200)]);
  return rows.map(toDTO);
}
export async function updateTestimonial(dataId: string, id: string, patch: { quote?: string; published?: boolean; featured?: boolean }): Promise<TestimonialDTO> {
  const cur = await getTestimonial(dataId, id);
  if (!cur) throw new TestimonialError("not_found", "Testimonial not found");
  await query(`UPDATE testimonials SET quote = $3, published = $4, featured = $5 WHERE id = $1 AND user_id = $2`, [id, dataId, (patch.quote ?? cur.quote).trim().slice(0, 1000), patch.published ?? cur.published, patch.featured ?? cur.featured]);
  return (await getTestimonial(dataId, id)) as TestimonialDTO;
}

/** Public: resolve an org slug (organizations.slug) to its data id and published testimonials. */
export async function publicTestimonials(slug: string): Promise<{ org_name: string; items: Array<Pick<TestimonialDTO, "quote" | "author_name" | "rating" | "featured" | "created_at">>; average: number | null } | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(slug)) return null;
  const org = await queryOne<{ owner_user_id: string; name: string }>(`SELECT owner_user_id, name FROM organizations WHERE lower(slug) = lower($1) LIMIT 1`, [slug]);
  if (!org) return null;
  const items = await listTestimonials(org.owner_user_id, { publishedOnly: true, limit: 50 });
  const brand = await getBranding(org.owner_user_id).catch(() => null);
  const rated = items.filter((i) => i.rating !== null);
  return {
    org_name: brand?.configured && brand.brand_name ? brand.brand_name : org.name,
    items: items.map((i) => ({ quote: i.quote, author_name: i.author_name, rating: i.rating, featured: i.featured, created_at: i.created_at })),
    average: rated.length ? Math.round((rated.reduce((s, i) => s + (i.rating ?? 0), 0) / rated.length) * 10) / 10 : null,
  };
}

export async function listResponses(dataId: string, opts: { surveyId?: string | null; limit?: number } = {}): Promise<Array<{ id: string; survey_id: string; score: number | null; comment: string | null; public: boolean; contact_name: string | null; created_at: string; testimonial_id: string | null }>> {
  const params: unknown[] = [dataId];
  let where = "r.user_id = $1";
  if (opts.surveyId) { params.push(opts.surveyId); where += ` AND r.survey_id = $${params.length}`; }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const rows = await query<{ id: string; survey_id: string; score: number | null; comment: string | null; public: boolean; contact_name: string | null; created_at: string | Date; testimonial_id: string | null }>(
    `SELECT r.id, r.survey_id, r.score, r.comment, r.public, c.full_name AS contact_name, r.created_at, t.id AS testimonial_id FROM survey_responses r LEFT JOIN crm_contacts c ON c.id = r.contact_id AND c.user_id = r.user_id LEFT JOIN testimonials t ON t.response_id = r.id AND t.user_id = r.user_id WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
}
