const encoder = new TextEncoder();

export async function sha256(data: string): Promise<string> {
	const buffer = encoder.encode(data);
	const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function sha256Bytes(data: Uint8Array): Promise<string> {
	const copy = new Uint8Array(data);
	const hashBuffer = await crypto.subtle.digest("SHA-256", copy);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
