// Adapted from omp-stats' app/Shell.tsx (MIT, Stencil Labs, Inc.; see ../kit/LICENSE).
import { Lock, LogOut, type LucideIcon, Menu, Monitor, Moon, Sun } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Badge, Dot, type Tone } from "../kit/ui";
import "./app.css";
import { NAV, NAV_ITEMS } from "./nav";
import { messageOf } from "./query";
import { navigate, type PageId } from "./route";
import { NEEDS_FULL_ACCESS, useAccess, useLiveConnected, useSession } from "./session";
import { type ThemePreference, useThemePreference } from "./theme";
import { UpdatePill } from "./UpdatePill";

export interface ShellProps {
	page: PageId;
	children: ReactNode;
}

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
	system: "light",
	light: "dark",
	dark: "system",
};

const PREFERENCE_ICON: Record<ThemePreference, LucideIcon> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
};

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
	system: "System theme",
	light: "Light theme",
	dark: "Dark theme",
};

/**
 * Fixed glass topbar + naked sidebar framing one inset content panel. Owns the global keyboard shortcut: `g` then a letter
 * jumps to a page.
 */
export function Shell({ page, children }: ShellProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const { identity } = useSession();
	const access = useAccess();
	const scrolled = useScrolled();
	useShortcuts();

	const go = (hash: string) => {
		navigate(hash);
		setMenuOpen(false);
		window.scrollTo({ top: 0 });
	};

	return (
		<>
			<div className="shell-ambient" />
			<header className="topbar" data-scrolled={scrolled}>
				<button
					type="button"
					className="btn topbar-menu"
					data-variant="ghost"
					data-icon="true"
					onClick={() => setMenuOpen(true)}
					aria-label="Open navigation"
				>
					<Menu size={16} />
				</button>
				<div className="topbar-brand">
					<svg className="topbar-mark" viewBox="0 0 64 64" width="22" height="22" aria-hidden="true">
						<defs>
							<linearGradient id="omp-mark-grad" x1="0" y1="0" x2="1" y2="1">
								<stop offset="0" stopColor="oklch(0.7 0.24 340)" />
								<stop offset=".5" stopColor="oklch(0.62 0.21 295)" />
								<stop offset="1" stopColor="oklch(0.81 0.14 200)" />
							</linearGradient>
						</defs>
						<path fill="url(#omp-mark-grad)" d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z" />
					</svg>
					<span>omp</span>
					<span className="topbar-slash">/</span>
					<span className="topbar-title">cloud</span>
					{identity.service.name !== "" && (
						<span className="topbar-chip" title={`omp-cloud ${identity.service.version}`}>
							{identity.service.name}
						</span>
					)}
				</div>
				<div className="topbar-spacer" />
				<div className="topbar-actions">
					<UpdatePill />
					<span className="topbar-hide-narrow">
						<LiveChip />
					</span>
					<AccountMenu />
					<ThemeToggle />
				</div>
			</header>

			{menuOpen && <div className="drawer-scrim" onClick={() => setMenuOpen(false)} role="presentation" />}
			<nav className="sidebar" data-open={menuOpen} aria-label="Pages">
				{NAV.map(group => (
					<div key={group.heading} className="nav-group">
						<div className="nav-heading">{group.heading}</div>
						{group.items.map(item => (
							<button
								key={item.id}
								type="button"
								className="nav-row"
								data-active={item.id === page}
								aria-current={item.id === page ? "page" : undefined}
								onClick={() => go(item.hash)}
							>
								<item.icon size={15} />
								<span className="nav-row-label">{item.label}</span>
								{item.needsFullAccess === true && access === "threads" && (
									<span className="nav-lock" title={NEEDS_FULL_ACCESS}>
										<Lock size={12} aria-label={NEEDS_FULL_ACCESS} />
									</span>
								)}
								<kbd>G {item.hotkey.toUpperCase()}</kbd>
							</button>
						))}
					</div>
				))}
				<div className="sidebar-foot micro">
					<span>
						<span className="kbd">G</span> then letter to jump
					</span>
				</div>
			</nav>

			<main className="shell-panel">
				<div className="shell-content">{children}</div>
			</main>
		</>
	);
}

/** Green while the shared event stream is open, amber while it reconnects. */
function LiveChip() {
	const connected = useLiveConnected();
	const tone: Tone | "live" = connected ? "live" : "warn";
	return (
		<span
			className="live-chip"
			role="status"
			title={connected ? "Receiving live updates from the service" : "Lost the live connection to the service; retrying"}
		>
			<Dot tone={tone} pulse={connected} />
			<span>{connected ? "Live" : "Reconnecting"}</span>
		</span>
	);
}

/** The signed-in user and Sign out. */
function AccountMenu() {
	const { identity, signOut } = useSession();
	const [busy, setBusy] = useState(false);
	const onSignOut = () => {
		setBusy(true);
		signOut().catch((error: unknown) => {
			setBusy(false);
			window.alert(`Sign-out failed: ${messageOf(error)}`);
		});
	};
	const { device } = identity;
	return (
		<>
			{device === null ? (
				<span className="topbar-user topbar-hide-narrow" title="Signed in on the server">
					Owner
				</span>
			) : (
				<span className="topbar-user topbar-hide-narrow row" title={`Signed in on device ${device.name}`}>
					{device.name}
					<Badge tone={device.access === "full" ? "ok" : "warn"}>{device.access === "full" ? "full access" : "threads only"}</Badge>
				</span>
			)}
			<button type="button" className="btn" data-size="sm" data-variant="ghost" onClick={onSignOut} disabled={busy} title="Sign out">
				<LogOut size={14} />
				<span className="topbar-hide-narrow">Sign out</span>
			</button>
		</>
	);
}

/** Cycles system → light → dark. */
function ThemeToggle() {
	const { preference, setPreference } = useThemePreference();
	const Icon = PREFERENCE_ICON[preference];
	return (
		<button
			type="button"
			className="btn"
			data-variant="ghost"
			data-icon="true"
			onClick={() => setPreference(NEXT_PREFERENCE[preference])}
			aria-label={`${PREFERENCE_LABEL[preference]} (click to switch)`}
			title={`${PREFERENCE_LABEL[preference]} — click to switch`}
		>
			<Icon size={15} />
		</button>
	);
}

function useScrolled(): boolean {
	const [scrolled, setScrolled] = useState(false);
	useEffect(() => {
		const onScroll = () => setScrolled(window.scrollY > 4);
		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);
	return scrolled;
}

function useShortcuts(): void {
	useEffect(() => {
		let pendingG = 0;
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
			const target = e.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable ||
					target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT")
			) {
				return;
			}
			if (document.querySelector('[aria-modal="true"]')) return;
			const key = e.key.toLowerCase();
			if (pendingG && Date.now() - pendingG < 1200) {
				pendingG = 0;
				const item = NAV_ITEMS.find(candidate => candidate.hotkey === key);
				if (item) {
					e.preventDefault();
					navigate(item.hash);
					window.scrollTo({ top: 0 });
				}
				return;
			}
			if (key === "g") pendingG = Date.now();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
