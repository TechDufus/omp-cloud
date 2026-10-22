import { Coins, GitBranch, KeyRound, LayoutGrid, LockKeyhole, type LucideIcon, MessagesSquare, Server, Settings, Smartphone } from "lucide-react";
import type { PageId } from "./route";

export interface NavItem {
	id: PageId;
	label: string;
	icon: LucideIcon;
	hash: string;
	/** Second key of the `g <key>` jump shortcut. */
	hotkey: string;
}

export interface NavGroup {
	heading: string;
	items: readonly NavItem[];
}

/** Sidebar structure; the order here is the order on screen. */
export const NAV: readonly NavGroup[] = [
	{
		heading: "Cloud",
		items: [
			{ id: "overview", label: "Overview", icon: LayoutGrid, hash: "#/", hotkey: "o" },
			{ id: "threads", label: "Threads", icon: MessagesSquare, hash: "#/threads", hotkey: "t" },
			{ id: "spend", label: "Spend", icon: Coins, hash: "#/spend", hotkey: "s" },
			{ id: "vms", label: "VMs", icon: Server, hash: "#/vms", hotkey: "v" },
		],
	},
	{
		heading: "Access",
		items: [
			{ id: "devices", label: "Devices", icon: Smartphone, hash: "#/devices", hotkey: "d" },
			{ id: "logins", label: "Logins", icon: KeyRound, hash: "#/logins", hotkey: "l" },
			{ id: "github", label: "GitHub", icon: GitBranch, hash: "#/github", hotkey: "g" },
			{ id: "secrets", label: "Secrets", icon: LockKeyhole, hash: "#/secrets", hotkey: "k" },
		],
	},
	{
		heading: "Settings",
		items: [{ id: "settings", label: "Settings", icon: Settings, hash: "#/settings", hotkey: "e" }],
	},
];

export const NAV_ITEMS: readonly NavItem[] = NAV.flatMap(group => group.items);
