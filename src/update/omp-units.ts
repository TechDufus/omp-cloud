/**
 * The systemd user units that run omp for the service: the auth broker and the gateway. `update.ompUnits` defaults
 * to them, and the update status reports their omp. Kept free of runtime imports, since the settings registry (and
 * through it the dashboard client's types) reads it.
 */
export const OMP_UNITS = ["omp-auth-broker", "omp-auth-gateway"] as const;
