/** Paired devices: the list with Revoke, and Pair a device (a code to paste on the other machine, then the owner approves the request). */
import { RotateCw } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import {
	ApiError,
	approveOffer,
	cancelOffer,
	createOffer,
	declineOffer,
	type Device,
	getOffer,
	listDevices,
	type OfferCreated,
	type OfferStatus,
	revokeDevice,
} from "../api";
import type { PageProps } from "../app/page";
import { useQuery } from "../app/query";
import { ago } from "../format";
import { Badge, Card, type Column, ErrorState, Modal, PageHeader, QueryView, Table, TableSkeleton } from "../kit/ui";
import { describe, readable } from "./access-errors";
import "./access.css";

const OFFER_POLL_MS = 1000;
const DEVICES_REFRESH_MS = 30_000;

const TERMINAL: Partial<Record<OfferStatus, true>> = { paired: true, declined: true, cancelled: true, burned: true, expired: true };

const ENDED: Partial<Record<OfferStatus, string>> = {
	declined: "You declined this device.",
	cancelled: "This pairing was cancelled.",
	burned: "Too many wrong attempts: this code is no longer valid.",
	expired: "This code expired.",
};

/** "4:32" until `expiresAt`, or "expired". */
function remaining(expiresAt: string, now: number): string {
	const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
	if (seconds === 0) return "expired";
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Time left on an offer, ticking each second. */
function Countdown({ expiresAt }: { expiresAt: string }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	return <span className="access-countdown">{remaining(expiresAt, now)}</span>;
}

type CopyState = "idle" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = { idle: "Copy code", copied: "Copied", failed: "Copy failed: select the code" };

interface OpenOfferProps {
	offer: OfferCreated;
	busy: boolean;
	onCancel: () => void;
}

/** An offer nobody has used yet: the code, its countdown and where the other machine connects. */
function OpenOffer({ offer, busy, onCancel }: OpenOfferProps) {
	const [copy, setCopy] = useState<CopyState>("idle");

	async function copyCode(): Promise<void> {
		try {
			await navigator.clipboard.writeText(offer.code);
			setCopy("copied");
		} catch {
			setCopy("failed");
		}
	}

	return (
		<div className="access-stack">
			<p>
				On the other machine, run <code>/cloud connect</code> in omp and paste this code. You approve the request here.
			</p>
			<div className="access-code">{offer.code}</div>
			<div className="access-actions">
				<button type="button" className="btn" data-variant="primary" onClick={() => void copyCode()}>
					{COPY_LABEL[copy]}
				</button>
				<button type="button" className="btn" disabled={busy} onClick={onCancel}>
					Cancel
				</button>
				<span className="muted">
					Expires in <Countdown expiresAt={offer.expiresAt} />
				</span>
			</div>
			<p className="access-fine">
				Stay on this page until the device is paired. The device connects to {offer.addresses.join(", ")} and checks the server's
				certificate {offer.fingerprint}.
			</p>
		</div>
	);
}

/** Pair a device: create an offer, show its code, approve or decline the request, then report the result. */
function PairCard({ active, onPaired }: { active: boolean; onPaired: () => void }) {
	const [offer, setOffer] = useState<OfferCreated | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	// Query results belong to their key, so a new offer never shows the last one's state. Polling stops once the poll reports a terminal status.
	const [settled, setSettled] = useState(false);
	const poll = useQuery(["pairing-offer", offer?.id], () => getOffer(offer?.id ?? ""), {
		enabled: active && offer !== null && !settled,
		refetchMs: OFFER_POLL_MS,
	});
	const polled = poll.data;
	// A 404 means the service no longer knows the offer: it expired.
	const gone = poll.error instanceof ApiError && poll.error.status === 404;
	const status: OfferStatus = offer === null ? "open" : gone ? "expired" : (polled?.status ?? "open");
	const ended = TERMINAL[status] === true;

	useEffect(() => {
		setSettled(ended);
	}, [ended]);

	const onPairedRef = useRef(onPaired);
	onPairedRef.current = onPaired;
	useEffect(() => {
		if (status === "paired") onPairedRef.current();
	}, [status]);

	// The code is gone with this page: a live offer is cancelled when the page is left or unmounted.
	const live = useRef<OfferCreated | null>(null);
	live.current = offer !== null && !ended ? offer : null;
	useEffect(() => {
		if (!active) {
			setOffer(null);
			setError(null);
			return;
		}
		return () => {
			const leaving = live.current;
			if (leaving) cancelOffer(leaving.id).catch(() => undefined);
		};
	}, [active]);

	async function create(): Promise<void> {
		setBusy(true);
		try {
			setOffer(await createOffer());
			setSettled(false);
			setError(null);
		} catch (failure) {
			setError(describe(failure));
		} finally {
			setBusy(false);
		}
	}

	/** Runs an approve, decline or cancel and refreshes the offer; the buttons stay off until it answers. */
	async function decide(action: (id: string) => Promise<void>): Promise<void> {
		if (!offer) return;
		setBusy(true);
		try {
			await action(offer.id);
			setError(null);
			poll.refetch();
		} catch (failure) {
			setError(describe(failure));
		} finally {
			setBusy(false);
		}
	}

	const request = polled?.request ?? null;
	let body: ReactElement;
	if (offer === null) {
		body = (
			<div className="access-stack">
				<p className="muted">
					Shows a code for the other machine. There, run <code>/cloud connect</code> in omp and paste the code; you approve the request
					here. The code is valid for 5 minutes and works once.
				</p>
				<div className="access-actions">
					<button type="button" className="btn" data-variant="primary" disabled={busy} onClick={() => void create()}>
						Pair a device
					</button>
				</div>
			</div>
		);
	} else if (status === "open") {
		body = <OpenOffer key={offer.id} offer={offer} busy={busy} onCancel={() => void decide(cancelOffer)} />;
	} else if (status === "pending") {
		body = (
			<div className="access-stack">
				<p>
					<strong>A device wants to pair.</strong>
				</p>
				{request && (
					<div className="kv">
						<div className="kv-item">
							<span className="kv-key">Name</span>
							<span className="kv-value">{request.name}</span>
						</div>
						<div className="kv-item">
							<span className="kv-key">Platform</span>
							<span className="kv-value">{request.platform}</span>
						</div>
						<div className="kv-item">
							<span className="kv-key">Address</span>
							<span className="kv-value">{request.address}</span>
						</div>
					</div>
				)}
				<p className="muted">
					Approve only if you started this on a machine of yours. Expires in <Countdown expiresAt={offer.expiresAt} />.
				</p>
				<div className="access-actions">
					<button type="button" className="btn" data-variant="primary" disabled={busy} onClick={() => void decide(approveOffer)}>
						Approve
					</button>
					<button type="button" className="btn" data-variant="danger" disabled={busy} onClick={() => void decide(declineOffer)}>
						Decline
					</button>
				</div>
			</div>
		);
	} else if (status === "approved") {
		body = <p className="muted">Approved. Waiting for the device to collect its token…</p>;
	} else {
		const paired = status === "paired";
		body = (
			<div className="access-stack">
				<p>{paired ? `Paired ${polled?.device?.name ?? "the device"}.` : (ENDED[status] ?? "This pairing ended.")}</p>
				<div className="access-actions">
					<button type="button" className="btn" data-variant="primary" disabled={busy} onClick={() => void create()}>
						{paired ? "Pair another device" : "Start over"}
					</button>
				</div>
			</div>
		);
	}

	return (
		<Card title="Pair a device" actions={offer !== null && !ended ? <Badge tone={status === "pending" ? "warn" : "accent"}>{status}</Badge> : undefined}>
			<div className="access-stack">
				{body}
				{error !== null && <ErrorState error={error} />}
				{poll.error !== undefined && poll.error !== null && !gone && <ErrorState error={describe(poll.error)} />}
			</div>
		</Card>
	);
}

/** The device list with Revoke behind a confirmation. */
export function DevicesPage({ active }: PageProps) {
	const devices = useQuery(["devices"], () => readable(listDevices()), { enabled: active, refetchMs: DEVICES_REFRESH_MS });
	const [revoking, setRevoking] = useState<Device | null>(null);
	const [revokeBusy, setRevokeBusy] = useState(false);
	const [revokeError, setRevokeError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	async function revoke(device: Device): Promise<void> {
		setRevokeBusy(true);
		try {
			const result = await revokeDevice(device.id);
			setNotice(
				result.runningThreads.length === 0
					? `Revoked ${result.device.name}.`
					: `Revoked ${result.device.name}. Threads it started are still running: ${result.runningThreads.join(", ")}.`,
			);
			setRevoking(null);
			setRevokeError(null);
			devices.refetch();
		} catch (failure) {
			setRevokeError(describe(failure));
		} finally {
			setRevokeBusy(false);
		}
	}

	const columns: readonly Column<Device>[] = [
		{
			key: "name",
			header: "Name",
			sort: device => device.name,
			render: device => (
				<span className="row">
					{device.name}
					{device.current && <Badge tone="accent">this device</Badge>}
				</span>
			),
		},
		{ key: "platform", header: "Platform", sort: device => device.platform, render: device => <span className="mono">{device.platform}</span> },
		{
			key: "paired",
			header: "Paired",
			sort: device => device.createdAt,
			render: device => `${ago(device.createdAt)} from ${device.pairedFrom}`,
		},
		{
			key: "lastSeen",
			header: "Last seen",
			sort: device => device.lastSeenAt ?? "",
			render: device =>
				device.lastSeenAt ? `${ago(device.lastSeenAt)}${device.lastSeenAddress ? ` from ${device.lastSeenAddress}` : ""}` : "never",
		},
		{
			key: "revoke",
			header: "",
			align: "right",
			render: device => (
				<button
					type="button"
					className="btn"
					data-size="sm"
					data-variant="danger"
					onClick={() => {
						setRevokeError(null);
						setRevoking(device);
					}}
				>
					Revoke
				</button>
			),
		},
	];

	return (
		<div className="page">
			<PageHeader
				title="Devices"
				description="Each paired device has its own token. Revoking one signs it out at once; its running requests and event streams end."
				actions={
					<button type="button" className="btn" data-size="sm" data-variant="ghost" onClick={devices.refetch}>
						<RotateCw size={13} /> Refresh
					</button>
				}
			/>
			<PairCard active={active} onPaired={devices.refetch} />
			<Card title="Paired devices" flush footer={notice === null ? undefined : <span className="access-ok">{notice}</span>}>
				<QueryView query={devices} skeleton={<TableSkeleton rows={4} />}>
					{rows => <Table columns={columns} rows={rows} rowKey={device => device.id} empty="No paired devices." />}
				</QueryView>
			</Card>
			<Modal
				open={revoking !== null}
				title="Revoke device"
				onClose={() => setRevoking(null)}
				primaryAction={{
					label: revokeBusy ? "Revoking…" : "Revoke",
					onClick: () => {
						if (revoking) void revoke(revoking);
					},
					disabled: revokeBusy,
				}}
			>
				<div className="access-stack">
					<p>Revoke "{revoking?.name}"? Its token stops working at once.</p>
					{revoking?.current && <p className="muted">This is the device you are using now: it loses access immediately.</p>}
					{revokeError !== null && <ErrorState error={revokeError} />}
				</div>
			</Modal>
		</div>
	);
}
