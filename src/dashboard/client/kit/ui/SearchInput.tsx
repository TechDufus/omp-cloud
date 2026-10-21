// MIT License. Copyright (c) 2025-2026 Can Bölük, 2026 Stencil Labs, Inc. Vendored from @oh-my-pi/omp-stats; see kit/LICENSE.
import { Search } from "lucide-react";

export interface SearchInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	width?: number;
}

/** Text filter with a leading search glyph. */
export function SearchInput({ value, onChange, placeholder = "Filter…", width }: SearchInputProps) {
	return (
		<label className="search">
			<Search size={14} />
			<input
				className="input"
				type="search"
				value={value}
				placeholder={placeholder}
				onChange={e => onChange(e.target.value)}
				style={width !== undefined ? { width } : undefined}
			/>
		</label>
	);
}
