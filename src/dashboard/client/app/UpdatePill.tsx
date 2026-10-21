/** The header's update pill, after Tern's: nothing when up to date, else the state with its one action. */
import { CircleArrowUp, CircleCheck, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { Modal } from "../kit/ui";
import { useUpdate } from "./update-context";

export function UpdatePill() {
	const { pill, busy, apply, check, dismiss } = useUpdate();
	const [confirming, setConfirming] = useState(false);
	const [reading, setReading] = useState(false);
	if (pill === null) return null;

	switch (pill.kind) {
		case "downloading":
			return (
				<span className="update-pill" data-tone="accent" role="status" title="Downloading and verifying the new version">
					<LoaderCircle size={13} className="update-spin" />
					<span className="update-pill-text">Downloading {pill.version}</span>
				</span>
			);
		case "applying":
			return (
				<span className="update-pill" data-tone="accent" role="status" title="The service is switching to the new version">
					<LoaderCircle size={13} className="update-spin" />
					<span className="update-pill-text">
						Updating to {pill.version}
						{pill.step !== "" && ` · ${pill.step}`}
					</span>
				</span>
			);
		case "restarting":
			return (
				<span className="update-pill" data-tone="accent" role="status" title="The service is restarting; sign in again if the dashboard asks">
					<LoaderCircle size={13} className="update-spin" />
					<span className="update-pill-text">Restarting to {pill.version}…</span>
				</span>
			);
		case "failed":
			return (
				<span className="update-pill" data-tone="bad" role="alert" title={pill.error}>
					<TriangleAlert size={13} />
					<span className="update-pill-text">Update failed: {pill.error}</span>
					<button
						type="button"
						className="btn"
						data-size="sm"
						disabled={busy}
						onClick={() => void (pill.retry === "apply" ? apply() : check())}
					>
						Retry
					</button>
				</span>
			);
		case "updated":
			return (
				<>
					<span className="update-pill" data-tone="ok" role="status">
						<CircleCheck size={13} />
						<span className="update-pill-text">Updated to {pill.version}</span>
						{pill.notes.trim() !== "" && (
							<button type="button" className="btn" data-size="sm" onClick={() => setReading(true)}>
								What's new
							</button>
						)}
						<button type="button" className="btn" data-variant="ghost" data-size="sm" data-icon="true" aria-label="Dismiss" onClick={dismiss}>
							<X size={13} />
						</button>
					</span>
					<Modal open={reading} title={`omp-cloud ${pill.version}`} onClose={() => setReading(false)} cancelLabel="Close">
						<p className="update-notes">{pill.notes.trim()}</p>
					</Modal>
				</>
			);
		case "ready":
			return (
				<>
					<span className="update-pill" data-tone="accent" role="status">
						<CircleArrowUp size={13} />
						<span className="update-pill-text">Update ready · {pill.version}</span>
						<button type="button" className="btn" data-variant="accent" data-size="sm" disabled={busy} onClick={() => setConfirming(true)}>
							Restart to update
						</button>
					</span>
					<Modal
						open={confirming}
						title={`Restart to update to ${pill.version}`}
						onClose={() => setConfirming(false)}
						primaryAction={{
							label: busy ? "Updating…" : "Restart to update",
							disabled: busy,
							onClick: () => {
								setConfirming(false);
								void apply();
							},
						}}
					>
						<p>
							omp-cloud restarts to run {pill.version}. This dashboard signs out when the service comes back; open a new link with{" "}
							<code>/cloud dashboard</code>.
						</p>
					</Modal>
				</>
			);
	}
}
