/** The signed-out screen: how to get a link, and the fallback of pasting the API token. */
import { type SubmitEvent, useState } from "react";
import { signIn } from "../api";
import { messageOf } from "../app/query";
import { Card } from "../kit/ui";
import "./signin.css";

export interface SignInProps {
	/** Why we are here (an expired session, a rejected link); empty for a plain visit. */
	notice: string;
	/** Runs once the service accepted the token. */
	onSignedIn: () => void;
}

export function SignIn({ notice, onSignedIn }: SignInProps) {
	const [token, setToken] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const value = token.trim();
		if (value === "") {
			setError("Paste the API token.");
			return;
		}
		setBusy(true);
		setError("");
		signIn({ token: value }).then(
			() => {
				setToken("");
				onSignedIn();
			},
			(failure: unknown) => {
				setError(messageOf(failure));
				setBusy(false);
			},
		);
	};

	return (
		<div className="signin-page">
			<div className="signin">
				<div className="signin-brand">
					<span>omp</span>
					<span className="topbar-slash">/</span>
					<span>cloud</span>
				</div>
				{notice !== "" && (
					<div className="error-state" role="alert">
						<span className="error-state-message">{notice}</span>
					</div>
				)}
				<Card title="Sign in" description="Open the link from omp, or paste the API token.">
					<p className="signin-hint">
						In omp, run <code>/cloud dashboard</code> and open the link it prints. A link works once and for 60 seconds.
					</p>
					<form className="signin-form" onSubmit={submit}>
						<label className="signin-label">
							API token
							<input
								className="input"
								type="password"
								autoComplete="off"
								spellCheck={false}
								placeholder="API token"
								value={token}
								onChange={event => setToken(event.target.value)}
							/>
						</label>
						{error !== "" && (
							<div className="error-state" role="alert">
								<span className="error-state-message">{error}</span>
							</div>
						)}
						<button type="submit" className="btn" data-variant="primary" disabled={busy}>
							Sign in
						</button>
					</form>
				</Card>
			</div>
		</div>
	);
}
