/** Upload limits of `POST /api/v1/threads`, per multipart part. */
export const MAX_SOURCE_BYTES = 1024 ** 3;
/** The `conversation` part: an `omp session pack` archive. */
export const MAX_SESSION_BYTES = 64 * 1024 ** 2;
/** The `setup` part: a tar.gz of `~/.omp/agent`. */
export const MAX_SETUP_BYTES = 64 * 1024 ** 2;
/** The `request` part: the JSON create request. */
export const MAX_REQUEST_PART_BYTES = 2 * 1024 ** 2;
/** The largest create body: every part at its limit plus 1 MiB of multipart framing. */
export const MAX_CREATE_BODY_BYTES =
	MAX_SOURCE_BYTES + MAX_SESSION_BYTES + MAX_SETUP_BYTES + MAX_REQUEST_PART_BYTES + 1024 ** 2;
