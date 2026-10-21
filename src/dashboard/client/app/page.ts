/** What every page component receives. Visited pages stay mounted but hidden, so only the active one fetches and polls. */
export interface PageProps {
	active: boolean;
}
