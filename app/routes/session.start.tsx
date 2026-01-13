/**
 * App Proxy Route - Handles requests when Shopify strips the /apps/editmuse prefix
 * 
 * This route handles /session/start when Shopify app proxy forwards requests
 * without the full path prefix. Re-exports the same handlers from the full path route.
 */
export { loader, action, options } from "./apps.editmuse.session.start";

