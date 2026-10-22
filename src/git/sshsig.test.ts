import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigningKey, sshFingerprint, sshPublicKey, sshSign } from "./sshsig";

/** A throwaway Ed25519 key made for this test only; it protects nothing. */
const FIXTURE_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKeoLuvt5Yvq6mM4BNjAK3mCn04i4d9ZwNx2mThy19ga
-----END PRIVATE KEY-----
`;
const FIXTURE_PUBLIC = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE4bJHKppJnbPmlSZ6KEsI8geB2bSkIZZwIFSMNBzdsd";
const FIXTURE_FINGERPRINT = "SHA256:Dr4Rl9ztN7r0A495WesaRqKSxs7nL3plDfoVjmauXHE";
const FIXTURE_MESSAGE = "omp-cloud known answer\n";
/** `ssh-keygen -Y sign -n git` over FIXTURE_MESSAGE with FIXTURE_PEM (OpenSSH 10.6). Ed25519 is deterministic. */
const FIXTURE_SIGNATURE = `-----BEGIN SSH SIGNATURE-----
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgThskcqmkmds+aVJnooSwjyB4HZ
tKQhlnAgVIw0HN2x0AAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5
AAAAQIdFYvDC0e9E+IZNN2WQ+vYn6O98M10moqQ4uSyGUu5tRsrjz6JZciWmVrJ460bLSh
XoSvCx7V3kfM++ysDtSwM=
-----END SSH SIGNATURE-----`;

const hasSshKeygen = Bun.which("ssh-keygen") !== null;

describe("sshsig", () => {
	test("the public key and fingerprint match what ssh-keygen derives from the fixture", () => {
		expect(sshPublicKey(FIXTURE_PEM, "omp-cloud")).toBe(`${FIXTURE_PUBLIC} omp-cloud`);
		expect(sshFingerprint(sshPublicKey(FIXTURE_PEM))).toBe(FIXTURE_FINGERPRINT);
	});

	test("known answer: the signature equals the one ssh-keygen made", () => {
		expect(sshSign(new TextEncoder().encode(FIXTURE_MESSAGE), FIXTURE_PEM)).toBe(FIXTURE_SIGNATURE);
	});

	test("the armor wraps at 70 columns", () => {
		const lines = sshSign(new Uint8Array([1, 2, 3]), FIXTURE_PEM).split("\n");
		expect(lines[0]).toBe("-----BEGIN SSH SIGNATURE-----");
		expect(lines.at(-1)).toBe("-----END SSH SIGNATURE-----");
		for (const line of lines.slice(1, -2)) expect(line).toHaveLength(70);
	});

	test("a generated key is a PKCS#8 Ed25519 key", () => {
		const { privatePem } = generateSigningKey();
		expect(privatePem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
		expect(sshPublicKey(privatePem)).toMatch(/^ssh-ed25519 \S+ omp-cloud$/);
	});

	test.skipIf(!hasSshKeygen)("ssh-keygen -Y verify accepts a signature of a generated key", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sshsig-"));
		try {
			const { privatePem } = generateSigningKey();
			const message = new TextEncoder().encode("interop message\n");
			await writeFile(join(dir, "signature"), `${sshSign(message, privatePem)}\n`);
			await writeFile(join(dir, "allowed"), `omp ${sshPublicKey(privatePem, "")}\n`);
			const verify = Bun.spawn(["ssh-keygen", "-Y", "verify", "-f", join(dir, "allowed"), "-I", "omp", "-n", "git", "-s", join(dir, "signature")], {
				stdin: message,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stderr = await new Response(verify.stderr).text();
			expect({ code: await verify.exited, stderr }).toEqual({ code: 0, stderr: "" });
			const wrongNamespace = Bun.spawn(["ssh-keygen", "-Y", "verify", "-f", join(dir, "allowed"), "-I", "omp", "-n", "file", "-s", join(dir, "signature")], {
				stdin: message,
				stdout: "ignore",
				stderr: "ignore",
			});
			expect(await wrongNamespace.exited).not.toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
