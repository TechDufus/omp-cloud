/** Every route under this prefix is `handleLogins`'s. */
export const LOGINS_PATH = "/api/v1/logins";
/** Every route under this prefix is `handleSettings`'s. */
export const SETTINGS_PATH = "/api/v1/settings";
/** Public (no token): a device redeems a pairing offer. */
export const REDEEM_PATH = "/api/v1/pairing/redeem";
/** Public (no token): a device collects its token once the owner approved. */
export const CLAIM_PATH = "/api/v1/pairing/claim";
/** The owner's pairing offers: the collection and, below it, `{id}`, `{id}/approve` and `{id}/decline`. */
export const OFFERS_PATH = "/api/v1/pairing/offers";
/** The paired devices: the collection and, below it, `{id}`. */
export const DEVICES_PATH = "/api/v1/devices";
/** The dashboard page's static files, relayed to paired devices: this path, then `/` or an asset path. */
export const DASHBOARD_STATIC_PATH = "/api/v1/dashboard/static";
