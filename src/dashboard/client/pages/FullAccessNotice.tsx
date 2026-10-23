/** What a page shows in place of its content when this device has threads-only access. */
import type { ReactNode } from "react";
import { useSession } from "../app/session";
import { Card, EmptyState, PageHeader } from "../kit/ui";

export function FullAccessNotice() {
	const { identity } = useSession();
	const name = identity.device?.name ?? "this device";
	return (
		<Card flush>
			<EmptyState
				title="Needs full access"
				hint={`This device (${name}) has threads-only access. From a connection with full access, open Devices and set it to Full, or run /cloud devices access ${name} full.`}
			/>
		</Card>
	);
}

/** A whole page behind full access: its header and the notice, with none of the page's own queries running. */
export function LockedPage({ title, description }: { title: string; description: ReactNode }) {
	return (
		<div className="page">
			<PageHeader title={title} description={description} />
			<FullAccessNotice />
		</div>
	);
}
