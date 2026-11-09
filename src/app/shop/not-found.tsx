/**
 * `notFound()` is thrown from `[org]/layout.tsx` when the slug is unknown or the
 * shop is switched off. A segment's own not-found only catches its children, so
 * the branded fallback has to live here, one level up — it still renders inside
 * `shop/layout.tsx`, so the brand header and footer stay in place.
 */
export { default } from "./[org]/not-found";
