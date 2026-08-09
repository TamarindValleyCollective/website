// Mirrors BaseLayout's own `organizationId` computation (see the sitewide
// Organization/WebSite graph there) - page-specific JSON-LD that wants to
// point back at the site's one Organization entity (via `@id` reference,
// e.g. AboutPage's mainEntity or ContactPage's mainEntity) needs the exact
// same id, not a second, differently-shaped Organization object.
export function organizationId(site: URL | undefined): string {
  return `${new URL('/', site).toString()}#organization`;
}
