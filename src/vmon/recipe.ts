import { DEFAULT_VM_PACKAGES, type SettingKey, type SettingValues } from "../settings/registry";

/** What the owner configures about the VM template: the Debian packages and the shell lines run at build, as `vm.packages` and `vm.setup`. */
export interface Recipe {
	/** Sorted and without duplicates, so the template hash does not depend on the order the owner listed them in. */
	packages: string[];
	/** Shell lines run as root, in order, after omp is installed. */
	setup: string[];
}

/** The recipe of a service whose owner changed nothing. */
export const DEFAULT_RECIPE: Recipe = recipeFrom(DEFAULT_VM_PACKAGES, []);

/** The recipe of `packages` and `setup`: packages sorted and deduplicated, setup as given. */
export function recipeFrom(packages: readonly string[], setup: readonly string[]): Recipe {
	return { packages: [...new Set(packages)].sort(), setup: [...setup] };
}

/** The recipe of the service's current `vm.*` settings. */
export function recipeOf(settings: { get<K extends SettingKey>(key: K): SettingValues[K] }): Recipe {
	return recipeFrom(settings.get("vm.packages"), settings.get("vm.setup"));
}
